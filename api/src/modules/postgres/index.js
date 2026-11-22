import { pgPool as pool } from '../../db.js';

// Toda consulta sobre asientos y reservas_asiento lleva sede_id: es la llave de
// la partición, y con ella PostgreSQL solo lee la de esa sede.
// pg devuelve BIGINT (asiento_id, COUNT) y NUMERIC (precios) como texto; se
// convierten en la consulta (::int, ::float8) para responder números como pide
// el contrato. Los asiento_id llegan a 10,000, así que caben en int.

const MINUTOS_RESERVA = 10;
const INTENTOS_DEADLOCK = 3;
const DEADLOCK = '40P01';

async function enTransaccion(trabajo) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// Se lanza dentro de la transacción para que haga ROLLBACK
class AsientosNoDisponibles extends Error {
  constructor(asientos) {
    super('asientos no disponibles');
    this.asientos = asientos;
  }
}

// Para validar la función en el paso 1 de la compra
export async function obtenerFuncion(funcionId) {
  const { rows: [funcion] } = await pool.query(
    'SELECT funcion_id, evento_id, sede_id, fecha_hora AS fecha, estado FROM funciones WHERE funcion_id = $1',
    [funcionId],
  );
  return funcion ?? null;
}

// GET /api/funciones?evento_id=
export async function listarFunciones(eventoId) {
  const { rows } = await pool.query(
    `SELECT f.funcion_id, f.evento_id, f.sede_id, s.ciudad AS sede, f.fecha_hora AS fecha,
            (SELECT count(*)::int FROM asientos a
              WHERE a.sede_id = f.sede_id AND a.funcion_id = f.funcion_id AND a.estado = 'libre') AS asientos_libres
       FROM funciones f
       JOIN sedes s ON s.sede_id = f.sede_id
      WHERE f.evento_id = $1
      ORDER BY f.fecha_hora`,
    [eventoId],
  );
  return rows;
}

// GET /api/funciones/:id/asientos?sede_id=
// null si la función no existe o no es de esa sede, para responder 404.
export async function asientosLibres(funcionId, sedeId) {
  const { rowCount } = await pool.query('SELECT 1 FROM funciones WHERE funcion_id = $1 AND sede_id = $2', [funcionId, sedeId]);
  if (rowCount === 0) return null;
  const { rows } = await pool.query(
    `SELECT a.asiento_id::int, z.nombre AS zona, z.precio_base::float8 AS precio
       FROM asientos a
       JOIN zonas z ON z.zona_id = a.zona_id
      WHERE a.sede_id = $1 AND a.funcion_id = $2 AND a.estado = 'libre'
      ORDER BY a.asiento_id`,
    [sedeId, funcionId],
  );
  return rows;
}

// Zona, precio y estado de los asientos pedidos, para crear la orden en MySQL
// (paso 2) antes de reservar. Si devuelve menos filas de las pedidas, algún
// asiento no es de esa función.
export async function obtenerAsientos({ sedeId, funcionId, asientos }) {
  const { rows } = await pool.query(
    `SELECT a.asiento_id::int, z.nombre AS zona, z.precio_base::float8 AS precio, a.estado
       FROM asientos a
       JOIN zonas z ON z.zona_id = a.zona_id
      WHERE a.sede_id = $1 AND a.funcion_id = $2 AND a.asiento_id = ANY($3::bigint[])
      ORDER BY a.asiento_id`,
    [sedeId, funcionId, asientos],
  );
  return rows;
}

// Paso 3 de la compra. Reserva todos los asientos o ninguno.
// El UPDATE solo toma los que siguen en 'libre'. Si dos compras piden el mismo
// asiento a la vez, PostgreSQL bloquea la fila: la segunda espera a que la
// primera termine, vuelve a revisar el WHERE, ve 'reservado' y no lo toma.
// Así ningún asiento se vende dos veces, sin SELECT ... FOR UPDATE (decisión 12).
//
// Devuelve { reservado: true, expira_en } o { reservado: false, no_disponibles }
// con los asientos que ya no estaban libres, para el 409.
export async function reservarAsientos({ sedeId, funcionId, ordenId, asientos }) {
  for (let intento = 1; ; intento++) {
    try {
      return await enTransaccion(async (c) => {
        const { rows } = await c.query(
          `UPDATE asientos SET estado = 'reservado'
            WHERE sede_id = $1 AND funcion_id = $2 AND asiento_id = ANY($3::bigint[]) AND estado = 'libre'
          RETURNING asiento_id::int`,
          [sedeId, funcionId, asientos],
        );
        if (rows.length < asientos.length) {
          const tomados = new Set(rows.map((r) => r.asiento_id));
          throw new AsientosNoDisponibles(asientos.filter((a) => !tomados.has(a)));
        }

        const { rows: [{ expira_en }] } = await c.query(
          `INSERT INTO reservas_asiento (sede_id, asiento_id, orden_id, expira_en)
           SELECT $1, unnest($2::bigint[]), $3, now() + make_interval(mins => $4)
           RETURNING expira_en`,
          [sedeId, asientos, ordenId, MINUTOS_RESERVA],
        );
        await c.query(
          `INSERT INTO movimientos_inventario (sede_id, asiento_id, tipo)
           SELECT $1, unnest($2::bigint[]), 'reserva'`,
          [sedeId, asientos],
        );
        return { reservado: true, expira_en };
      });
    } catch (e) {
      if (e instanceof AsientosNoDisponibles) return { reservado: false, no_disponibles: e.asientos };
      // Dos compras con asientos en común pueden bloquearse entre sí; PostgreSQL
      // aborta una. Se reintenta en vez de responder un 409 que no es real.
      if (e.code === DEADLOCK && intento < INTENTOS_DEADLOCK) continue;
      throw e;
    }
  }
}
