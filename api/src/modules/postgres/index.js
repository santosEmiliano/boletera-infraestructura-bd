import { pgPool as pool } from '../../db.js';

// Toda consulta sobre asientos y reservas_asiento lleva sede_id: es la llave de
// la partición, y con ella PostgreSQL solo lee la de esa sede.
// pg devuelve BIGINT (asiento_id, COUNT) y NUMERIC (precios) como texto; se
// convierten en la consulta (::int, ::float8) para responder números como pide
// el contrato. Los asiento_id llegan a 10,000, así que caben en int.

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
