import pg from 'pg';

// PostgreSQL tiene un primario (PC2) y una réplica de solo lectura (PC3). Si el
// primario cae, la réplica se promueve a mano con pg_promote(). Este pool se
// conecta al primario y, cuando la conexión falla o una escritura cae en la
// réplica, pregunta a cada nodo quién es el primario y cambia solo. Así la API
// no hay que reiniciarla después de promover.

// La sentencia no llegó a ejecutarse, se puede repetir sin riesgo
const SIN_EJECUTAR = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  '25006', // read_only_sql_transaction: se escribió en la réplica
  '57P03', // cannot_connect_now: el servidor está arrancando
]);
// Puede haberse ejecutado o no: se busca al primario pero la repetición
// la decide quien llamó
const AMBIGUOS = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02']);

const sinEjecutar = (e) => SIN_EJECUTAR.has(e?.code) || /timeout exceeded when trying to connect/.test(e?.message ?? '');
const cambioDePrimario = (e) => sinEjecutar(e)
  || AMBIGUOS.has(e?.code)
  || String(e?.code ?? '').startsWith('08')
  || /Connection terminated/.test(e?.message ?? '');
const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// "pc2" o "pc2:5433"
export function separarHost(texto, puertoPorDefecto) {
  const [host, puerto] = texto.split(':');
  return { host, port: puerto ? Number(puerto) : puertoPorDefecto };
}

async function esPrimario(conexion, nodo) {
  const c = new pg.Client({ ...conexion, ...separarHost(nodo, conexion.port), connectionTimeoutMillis: 1500 });
  c.on('error', () => {});
  try {
    await c.connect();
    const { rows: [{ replica }] } = await c.query('SELECT pg_is_in_recovery() AS replica');
    return !replica;
  } finally {
    await c.end().catch(() => {});
  }
}

export function crearPoolPostgres(conexion, {
  hosts, esperaMs = 5000, cadaMs = 500, verificarCadaMs = 2000, buscarAlInicio = true, crearPool, preguntar,
} = {}) {
  const nuevoPool = crearPool ?? ((nodo) => {
    const p = new pg.Pool({ ...conexion, ...separarHost(nodo, conexion.port), max: 20, connectionTimeoutMillis: 2000 });
    // Sin este listener, un cliente inactivo que pierde la conexión tira el proceso
    p.on('error', (e) => console.error(`postgres ${nodo}:`, e.message));
    return p;
  });
  const esElPrimario = preguntar ?? ((nodo) => esPrimario(conexion, nodo));

  // Con un solo nodo no hay a quién buscar
  if (hosts.length === 1) {
    const unico = nuevoPool(hosts[0]);
    return {
      query: (...args) => unico.query(...args),
      connect: () => unico.connect(),
      end: () => unico.end(),
      primarioActual: () => hosts[0],
    };
  }

  let host = hosts[0];
  let pool = nuevoPool(host);
  let confirmado = false;
  let buscando = null;

  async function buscar() {
    const limite = Date.now() + esperaMs;
    // Por qué no respondió cada nodo en la última vuelta (clave equivocada, nodo
    // apagado...), para que el error final diga la causa
    const motivos = new Map();
    do {
      motivos.clear();
      const respuestas = await Promise.all(hosts.map(async (h) => {
        try {
          return (await esElPrimario(h)) ? h : null;
        } catch (e) {
          motivos.set(h, e.message || e.code);
          return null;
        }
      }));
      const primarios = respuestas.filter(Boolean);
      // Dos primarios: el viejo volvió sin reconstruirse como réplica (ver
      // docs/procedimientos-falla.md). Si ya se estaba usando uno de ellos, se
      // sigue con ese; si no, no se elige ninguno para no escribir en el viejo.
      if (primarios.length > 1) {
        console.error(`PostgreSQL: hay dos primarios (${primarios.join(', ')}). Hay que reconstruir el viejo como réplica.`);
        if (confirmado && primarios.includes(host)) return;
      } else if (primarios.length === 1) {
        const [primario] = primarios;
        if (primario !== host) {
          console.log(`PostgreSQL: el primario ahora es ${primario} (antes ${host})`);
          const anterior = pool;
          host = primario;
          pool = nuevoPool(primario);
          anterior.end().catch(() => {});
        }
        confirmado = true;
        return;
      }
      await dormir(cadaMs);
    } while (Date.now() < limite);
    const detalle = [...motivos].map(([h, m]) => `${h}: ${m}`).join('; ');
    throw Object.assign(
      new Error(`PostgreSQL: no hay un primario disponible${detalle ? ` (${detalle})` : ''}`),
      { code: 'SIN_PRIMARIO' },
    );
  }

  // Varias peticiones fallando a la vez comparten una sola búsqueda
  const reubicar = () => (buscando ??= buscar().finally(() => { buscando = null; }));

  async function conPool(operacion) {
    // Hasta confirmar un primario no se usa ningún nodo: el primero de la lista
    // podría ser un viejo primario que volvió sin reconstruirse
    if (buscando || !confirmado) await reubicar();
    try {
      return await operacion(pool);
    } catch (e) {
      if (!cambioDePrimario(e)) throw e;
      await reubicar();
      if (sinEjecutar(e)) return operacion(pool);
      throw e;
    }
  }

  // Dentro de una transacción no se puede repetir a mitad: se avisa que hay que
  // buscar al primario y el error sigue su camino para que lo reintente el orquestador
  function vigilar(cliente) {
    // El pool reutiliza los clientes: se envuelve cada uno una sola vez
    if (cliente.vigilado) return cliente;
    cliente.vigilado = true;
    const original = cliente.query.bind(cliente);
    cliente.query = async (...args) => {
      try {
        return await original(...args);
      } catch (e) {
        if (cambioDePrimario(e)) reubicar().catch(() => {});
        throw e;
      }
    };
    return cliente;
  }

  if (buscarAlInicio) reubicar().catch(() => {});

  // Comprueba cada tanto que el nodo actual siga siendo el primario, por si cambió
  // sin que ninguna operación fallara
  const vigilante = verificarCadaMs > 0 && setInterval(async () => {
    if (buscando) return;
    if (!(await esElPrimario(host).catch(() => false))) reubicar().catch(() => {});
  }, verificarCadaMs).unref();

  return {
    query: (...args) => conPool((p) => p.query(...args)),
    connect: async () => vigilar(await conPool((p) => p.connect())),
    end: () => {
      clearInterval(vigilante);
      return pool.end();
    },
    primarioActual: () => host,
  };
}
