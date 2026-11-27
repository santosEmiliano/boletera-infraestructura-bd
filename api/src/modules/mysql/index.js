import { randomUUID } from 'node:crypto';
import { mysqlPool as pool } from '../../db.js';

async function enTransaccion(trabajo) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const resultado = await trabajo(conn);
    await conn.commit();
    return resultado;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// El fragmento de facturación solo se consulta cuando hace falta
export async function obtenerCliente(clienteId, { facturacion = false } = {}) {
  const [[cliente]] = await pool.execute(
    'SELECT cliente_id, nombre, apellidos, email, telefono, ciudad FROM clientes_contacto WHERE cliente_id = ?',
    [clienteId],
  );
  if (!cliente) return null;
  if (facturacion) {
    const [[fiscal]] = await pool.execute(
      'SELECT rfc, razon_social, direccion_fiscal, metodo_pago_pref FROM clientes_facturacion WHERE cliente_id = ?',
      [clienteId],
    );
    cliente.facturacion = fiscal ?? null;
  }
  return cliente;
}

// asientos: [{ asiento_id, zona, precio }], todos de la misma sede
export function crearOrden({ clienteId, eventoId, funcionId, sedeId, asientos }) {
  const total = Math.round(asientos.reduce((suma, a) => suma + a.precio, 0) * 100) / 100;
  return enTransaccion(async (conn) => {
    const [orden] = await conn.execute(
      'INSERT INTO ordenes (cliente_id, evento_id, funcion_id, total) VALUES (?, ?, ?, ?)',
      [clienteId, eventoId, funcionId, total],
    );
    const filas = asientos.map((a) => [orden.insertId, sedeId, a.asiento_id, a.zona, a.precio]);
    await conn.query('INSERT INTO orden_detalle (orden_id, sede_id, asiento_id, zona, precio) VALUES ?', [filas]);
    return { orden_id: orden.insertId, total };
  });
}

export async function registrarPago({ ordenId, monto, metodo, estado, referencia = null }) {
  const [r] = await pool.execute(
    'INSERT INTO pagos (orden_id, monto, metodo, estado, referencia) VALUES (?, ?, ?, ?, ?)',
    [ordenId, monto, metodo, estado, referencia],
  );
  return r.insertId;
}

// Solo una orden pendiente cambia de estado. Repetir la llamada con el mismo
// estado también devuelve true, para poder reintentar sin miedo.
async function cambiarEstado(ordenId, nuevo) {
  const [r] = await pool.execute("UPDATE ordenes SET estado = ? WHERE orden_id = ? AND estado = 'pendiente'", [nuevo, ordenId]);
  if (r.affectedRows === 1) return true;
  const [[orden]] = await pool.execute('SELECT estado FROM ordenes WHERE orden_id = ?', [ordenId]);
  return orden?.estado === nuevo;
}

export const marcarOrdenPagada = (ordenId) => cambiarEstado(ordenId, 'pagada');
export const cancelarOrden = (ordenId) => cambiarEstado(ordenId, 'cancelada');
export const expirarOrden = (ordenId) => cambiarEstado(ordenId, 'expirada');

// Órdenes 'pendiente' que quedaron huérfanas: sin reserva y sin nadie que las
// termine. Pasa cuando crearOrden se reintenta tras un cambio de primario y
// MySQL sí había guardado el primer intento. Una compra real tarda milisegundos
// y su reserva dura 10 minutos, así que pasado ese margen ninguna orden
// pendiente sigue en curso. Devuelve cuántas marcó como 'expirada'.
export async function expirarHuerfanas(minutos) {
  const [r] = await pool.execute(
    "UPDATE ordenes SET estado = 'expirada' WHERE estado = 'pendiente' AND creada_en < NOW() - INTERVAL ? MINUTE",
    [minutos],
  );
  return r.affectedRows;
}

// Si la orden ya tiene boletos (un reintento tras un corte), devuelve los mismos
export function emitirBoletos(ordenId) {
  const columnas = 'boleto_id, sede_id, asiento_id, codigo_qr';
  return enTransaccion(async (conn) => {
    const [[orden]] = await conn.execute('SELECT estado FROM ordenes WHERE orden_id = ? FOR UPDATE', [ordenId]);
    if (orden?.estado !== 'pagada') throw new Error(`La orden ${ordenId} no está pagada`);

    const [existentes] = await conn.execute(`SELECT ${columnas} FROM boletos WHERE orden_id = ? ORDER BY boleto_id`, [ordenId]);
    if (existentes.length) return existentes;

    const [detalle] = await conn.execute('SELECT sede_id, asiento_id FROM orden_detalle WHERE orden_id = ? ORDER BY detalle_id', [ordenId]);
    const filas = detalle.map((d) => [ordenId, d.sede_id, d.asiento_id, randomUUID().replaceAll('-', '')]);
    await conn.query('INSERT INTO boletos (orden_id, sede_id, asiento_id, codigo_qr) VALUES ?', [filas]);

    const [boletos] = await conn.execute(`SELECT ${columnas} FROM boletos WHERE orden_id = ? ORDER BY boleto_id`, [ordenId]);
    return boletos;
  });
}

// El UPDATE condicionado evita que dos escaneos simultáneos acepten el mismo boleto
export async function marcarBoletoUsado(codigoQr) {
  const [r] = await pool.execute("UPDATE boletos SET estado = 'usado' WHERE codigo_qr = ? AND estado = 'emitido'", [codigoQr]);
  const [[boleto]] = await pool.execute('SELECT boleto_id, estado FROM boletos WHERE codigo_qr = ?', [codigoQr]);
  if (!boleto) return { resultado: 'no_existe' };
  if (r.affectedRows === 1) return { resultado: 'valido', boleto_id: boleto.boleto_id };
  return { resultado: 'no_valido', boleto_id: boleto.boleto_id, estado: boleto.estado };
}
