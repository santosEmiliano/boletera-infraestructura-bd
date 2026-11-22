import { pgPool as pool } from '../../db.js';

// Libera las reservas activas que ya vencieron (no se pagaron en 10 minutos).
// Es una sola sentencia, así que es atómica: reservas 'expirada', asientos de
// vuelta a 'libre' y un movimiento 'liberacion' por asiento. Encuentra las
// vencidas con el índice parcial idx_reservas_expiracion.
// Si una compra confirma la misma reserva al mismo tiempo, PostgreSQL bloquea la
// fila y solo una de las dos la cambia: la otra ve que ya no está 'activa'.
const SQL_EXPIRAR = `
  WITH vencidas AS (
    UPDATE reservas_asiento SET estado = 'expirada'
     WHERE estado = 'activa' AND expira_en < now()
    RETURNING sede_id, asiento_id, orden_id
  ), liberados AS (
    UPDATE asientos a SET estado = 'libre'
      FROM vencidas v
     WHERE a.sede_id = v.sede_id AND a.asiento_id = v.asiento_id AND a.estado = 'reservado'
    RETURNING a.sede_id, a.asiento_id
  ), movimientos AS (
    INSERT INTO movimientos_inventario (sede_id, asiento_id, tipo)
    SELECT sede_id, asiento_id, 'liberacion' FROM liberados
  )
  SELECT DISTINCT orden_id FROM vencidas`;

// Devuelve los orden_id que tenían reservas vencidas
export async function expirarVencidas() {
  const { rows } = await pool.query(SQL_EXPIRAR);
  return rows.map((r) => Number(r.orden_id));
}

// Corre expirarVencidas al arrancar y luego cada minuto, y avisa con
// alExpirar(ordenId) para que la orden quede 'expirada' en MySQL.
// Si el aviso falla (MySQL caído), la orden se guarda y se reintenta en la
// siguiente vuelta: en PostgreSQL ya no aparecería como vencida.
export function iniciarExpiracion({ alExpirar, cadaMs = 60_000 }) {
  const porAvisar = new Set();
  let corriendo = false;

  async function vuelta() {
    if (corriendo) return;
    corriendo = true;
    try {
      const ordenes = await expirarVencidas();
      ordenes.forEach((id) => porAvisar.add(id));
      if (ordenes.length) console.log(`expiración: ${ordenes.length} órdenes con reservas vencidas`);
    } catch (e) {
      console.error('expiración (postgres):', e.message);
    }
    try {
      for (const ordenId of porAvisar) {
        await alExpirar(ordenId);
        porAvisar.delete(ordenId);
      }
    } catch (e) {
      console.error(`expiración (mysql): ${porAvisar.size} órdenes por avisar:`, e.message);
    } finally {
      corriendo = false;
    }
  }

  vuelta();
  const reloj = setInterval(vuelta, cadaMs);
  reloj.unref();
  return { detener: () => clearInterval(reloj) };
}
