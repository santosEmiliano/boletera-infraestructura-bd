import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongo, mysqlPool as pool } from '../src/db.js';
import * as mysql from '../src/modules/mysql/index.js';
import { registrarAcceso } from '../src/modules/mongo/index.js';

// Necesita MySQL con el esquema y MongoDB a la vez:
//  PRUEBAS_BD=1 MYSQL_USER=... MYSQL_PASSWORD=... MONGO_URI=... node --test test/acceso.test.js
const omitir = process.env.PRUEBAS_BD !== '1' && 'define PRUEBAS_BD=1 para correrlas';

const PUERTA = 'prueba-automatica';
let clienteId;
let ordenId;
let qr;
const bitacora = () => mongo.db().collection('bitacora_accesos');

before(async () => {
  if (omitir) return;
  const [r] = await pool.execute(
    'INSERT INTO clientes_contacto (nombre, apellidos, email) VALUES (?, ?, ?)',
    ['Prueba', 'Acceso', `${randomUUID()}@example.com`],
  );
  clienteId = r.insertId;
  ({ orden_id: ordenId } = await mysql.crearOrden({
    clienteId,
    eventoId: 'b'.repeat(24),
    funcionId: 1,
    sedeId: 1,
    asientos: [{ asiento_id: 1, zona: 'VIP', precio: 1800 }],
  }));
  await mysql.marcarOrdenPagada(ordenId);
  [{ codigo_qr: qr }] = await mysql.emitirBoletos(ordenId);
});

after(async () => {
  if (omitir) return;
  await bitacora().deleteMany({ puerta: PUERTA });
  const [ordenes] = await pool.execute('SELECT orden_id FROM ordenes WHERE cliente_id = ?', [clienteId]);
  for (const { orden_id } of ordenes) {
    for (const tabla of ['boletos', 'pagos', 'orden_detalle', 'ordenes']) {
      await pool.execute(`DELETE FROM ${tabla} WHERE orden_id = ?`, [orden_id]);
    }
  }
  await pool.execute('DELETE FROM clientes_contacto WHERE cliente_id = ?', [clienteId]);
  await pool.end();
  await mongo.close();
});

test('registrarAcceso: el primer escaneo es válido y queda en la bitácora', { skip: omitir }, async () => {
  const r = await registrarAcceso({ codigoQr: qr, puerta: PUERTA });
  assert.equal(r.resultado, 'valido');
  const [[boleto]] = await pool.execute('SELECT estado FROM boletos WHERE codigo_qr = ?', [qr]);
  assert.equal(boleto.estado, 'usado');
  const doc = await bitacora().findOne({ codigo_qr: qr, puerta: PUERTA });
  assert.equal(doc.resultado, 'valido');
  assert.equal(doc.boleto_id, r.boleto_id);
});

test('registrarAcceso: el segundo escaneo del mismo boleto se rechaza y también se registra', { skip: omitir }, async () => {
  const r = await registrarAcceso({ codigoQr: qr, puerta: PUERTA });
  assert.equal(r.resultado, 'no_valido');
  assert.equal(r.estado, 'usado');
  const docs = await bitacora().find({ codigo_qr: qr, puerta: PUERTA }).sort({ fecha: 1 }).toArray();
  assert.deepEqual(docs.map((d) => d.resultado), ['valido', 'no_valido']);
});

test('registrarAcceso: un QR que no existe se registra sin boleto', { skip: omitir }, async () => {
  const falso = 'f'.repeat(32);
  const r = await registrarAcceso({ codigoQr: falso, puerta: PUERTA });
  assert.equal(r.resultado, 'no_existe');
  const doc = await bitacora().findOne({ codigo_qr: falso });
  assert.equal(doc.resultado, 'no_existe');
  assert.equal(doc.boleto_id, null);
});

test('registrarAcceso: si la bitácora falla, un boleto válido no se rechaza', { skip: omitir }, async (t) => {
  const orden = await mysql.crearOrden({
    clienteId,
    eventoId: 'b'.repeat(24),
    funcionId: 1,
    sedeId: 1,
    asientos: [{ asiento_id: 2, zona: 'VIP', precio: 1800 }],
  });
  await mysql.marcarOrdenPagada(orden.orden_id);
  const [{ codigo_qr }] = await mysql.emitirBoletos(orden.orden_id);

  t.mock.method(console, 'error', () => {});
  t.mock.method(mongo, 'db', () => ({
    collection: () => ({ insertOne: async () => { throw new Error('mongo caido'); } }),
  }));
  const r = await registrarAcceso({ codigoQr: codigo_qr, puerta: PUERTA });
  assert.equal(r.resultado, 'valido');
  const [[boleto]] = await pool.execute('SELECT estado FROM boletos WHERE codigo_qr = ?', [codigo_qr]);
  assert.equal(boleto.estado, 'usado');
});
