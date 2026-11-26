import mysql from 'mysql2/promise';

// El grupo de MySQL tiene un solo primario y es el único que acepta escrituras.
// Este pool se conecta al primario y, si deja de serlo, lo busca entre los
// demás nodos y cambia solo.

// La sentencia no llegó a ejecutarse, se puede repetir sin riesgo
const SIN_EJECUTAR = new Set([
  'ER_OPTION_PREVENTS_STATEMENT', 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
]);
// Puede haberse ejecutado o no: se busca al primario pero la repetición
// la decide quien llamó
const AMBIGUOS = new Set(['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE']);

const cambioDePrimario = (e) => SIN_EJECUTAR.has(e?.code) || AMBIGUOS.has(e?.code);
const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

async function esPrimario(conexion, host) {
  const c = await mysql.createConnection({ ...conexion, host, connectTimeout: 1500 });
  try {
    const [[fila]] = await c.query(
      `SELECT m.MEMBER_ROLE AS rol, m.MEMBER_STATE AS estado, @@super_read_only AS solo_lectura
         FROM performance_schema.replication_group_members m
        WHERE m.MEMBER_ID = @@server_uuid`,
    );
    return fila?.rol === 'PRIMARY' && fila.estado === 'ONLINE' && !fila.solo_lectura;
  } finally {
    await c.end().catch(() => {});
  }
}

// buscarAlInicio y verificarCadaMs cubren un nodo que reinició y quedó fuera del
// grupo: sigue aceptando escrituras, pero aislado. Ningún error avisaría de eso,
// así que se comprueba al arrancar y cada tanto que el nodo actual siga siendo
// el primario.
export function crearPoolMysql(conexion, {
  hosts, esperaMs = 15000, cadaMs = 500, verificarCadaMs = 2000, buscarAlInicio = true, crearPool, preguntar,
} = {}) {
  const nuevoPool = crearPool ?? ((host) => mysql.createPool({
    ...conexion, host, connectionLimit: 10, connectTimeout: 2000, decimalNumbers: true,
  }));
  const esElPrimario = preguntar ?? ((host) => esPrimario(conexion, host));

  // Con un solo nodo no hay a quién buscar (y un MySQL sin grupo nunca diría PRIMARY)
  if (hosts.length === 1) {
    const unico = nuevoPool(hosts[0]);
    return {
      execute: (...args) => unico.execute(...args),
      query: (...args) => unico.query(...args),
      getConnection: () => unico.getConnection(),
      end: () => unico.end(),
      primarioActual: () => hosts[0],
    };
  }

  let host = hosts[0];
  let pool = nuevoPool(host);
  let buscando = null;

  async function buscar() {
    const limite = Date.now() + esperaMs;
    do {
      const respuestas = await Promise.all(hosts.map(async (h) => (await esElPrimario(h).catch(() => false)) ? h : null));
      const primario = respuestas.find(Boolean);
      if (primario) {
        if (primario !== host) {
          console.log(`MySQL: el primario ahora es ${primario} (antes ${host})`);
          const anterior = pool;
          host = primario;
          pool = nuevoPool(primario);
          anterior.end().catch(() => {});
        }
        return;
      }
      await dormir(cadaMs);
    } while (Date.now() < limite);
    throw Object.assign(new Error('MySQL: no hay un primario disponible'), { code: 'SIN_PRIMARIO' });
  }

  // Varias peticiones fallando a la vez comparten una sola búsqueda
  const reubicar = () => (buscando ??= buscar().finally(() => { buscando = null; }));

  async function conPool(operacion) {
    if (buscando) await buscando;
    try {
      return await operacion(pool);
    } catch (e) {
      if (!cambioDePrimario(e)) throw e;
      await reubicar();
      if (SIN_EJECUTAR.has(e.code)) return operacion(pool);
      throw e;
    }
  }

  // Dentro de una transacción no se puede repetir a mitad: se avisa que hay que
  // buscar al primario y el error sigue su camino para que lo reintente el orquestador
  function vigilar(conn) {
    for (const metodo of ['execute', 'query', 'beginTransaction', 'commit']) {
      const original = conn[metodo].bind(conn);
      conn[metodo] = async (...args) => {
        try {
          return await original(...args);
        } catch (e) {
          if (cambioDePrimario(e)) reubicar().catch(() => {});
          throw e;
        }
      };
    }
    return conn;
  }

  if (buscarAlInicio) reubicar().catch(() => {});

  const vigilante = verificarCadaMs > 0 && setInterval(async () => {
    if (buscando) return;
    if (!(await esElPrimario(host).catch(() => false))) reubicar().catch(() => {});
  }, verificarCadaMs).unref();

  return {
    execute: (...args) => conPool((p) => p.execute(...args)),
    query: (...args) => conPool((p) => p.query(...args)),
    getConnection: async () => vigilar(await conPool((p) => p.getConnection())),
    end: () => {
      clearInterval(vigilante);
      return pool.end();
    },
    primarioActual: () => host,
  };
}
