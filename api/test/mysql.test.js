import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mysqlPool as pool } from '../src/db.js';
import * as mysql from '../src/modules/mysql/index.js';

const omitir = process.env.PRUEBAS_BD !== '1' && 'define PRUEBAS_BD=1 para correrlas';

const EVENTO = 'a'.repeat(24);
const asientos = [
  { asiento_id: 1, zona: 'VIP', precio: 1800 },
  { asiento_id: 2, zona: 'VIP', precio: 1800.5 },
];
let clienteId;

const estadoDe = async (ordenId) => (await pool.execute('SELECT estado FROM ordenes WHERE orden_id = ?', [ordenId]))[0][0].estado;
const nuevaOrden = () => mysql.crearOrden({ clienteId, eventoId: EVENTO, funcionId: 1, sedeId: 1, asientos });

before(async () => {
  if (omitir) return;
  const [r] = await pool.execute(
    'INSERT INTO clientes_contacto (nombre, apellidos, email) VALUES (?, ?, ?)',
    ['Prueba', 'Automatica', `${randomUUID()}@example.com`],
  );
  clienteId = r.insertId;
  await pool.execute('INSERT INTO clientes_facturacion (cliente_id, rfc, razon_social) VALUES (?, ?, ?)', [clienteId, 'ABCD123456XYZ', 'Prueba SA']);
});

after(async () => {
  if (omitir) return;
  const [ordenes] = await pool.execute('SELECT orden_id FROM ordenes WHERE cliente_id = ?', [clienteId]);
  for (const { orden_id } of ordenes) {
    for (const tabla of ['boletos', 'pagos', 'orden_detalle', 'ordenes']) {
      await pool.execute(`DELETE FROM ${tabla} WHERE orden_id = ?`, [orden_id]);
    }
  }
  await pool.execute('DELETE FROM clientes_facturacion WHERE cliente_id = ?', [clienteId]);
  await pool.execute('DELETE FROM clientes_contacto WHERE cliente_id = ?', [clienteId]);
  await pool.end();
});

test('obtenerCliente: la facturación solo viene si se pide', { skip: omitir }, async () => {
  const simple = await mysql.obtenerCliente(clienteId);
  assert.equal(simple.nombre, 'Prueba');
  assert.equal('facturacion' in simple, false);
  const completo = await mysql.obtenerCliente(clienteId, { facturacion: true });
  assert.equal(completo.facturacion.rfc, 'ABCD123456XYZ');
  assert.equal(await mysql.obtenerCliente(2147483000), null);
});

test('crearOrden: guarda la orden pendiente y su detalle', { skip: omitir }, async () => {
  const { orden_id, total } = await nuevaOrden();
  assert.equal(total, 3600.5);
  assert.equal(await estadoDe(orden_id), 'pendiente');
  const [[orden]] = await pool.execute('SELECT total FROM ordenes WHERE orden_id = ?', [orden_id]);
  assert.equal(orden.total, 3600.5);
  const [detalle] = await pool.execute('SELECT asiento_id FROM orden_detalle WHERE orden_id = ?', [orden_id]);
  assert.equal(detalle.length, 2);
});

test('crearOrden: si falla el detalle no queda la orden', { skip: omitir }, async () => {
  const antes = (await pool.execute('SELECT COUNT(*) AS n FROM ordenes WHERE cliente_id = ?', [clienteId]))[0][0].n;
  await assert.rejects(mysql.crearOrden({
    clienteId, eventoId: EVENTO, funcionId: 1, sedeId: 1,
    asientos: [{ asiento_id: 1, zona: null, precio: 100 }],
  }));
  const despues = (await pool.execute('SELECT COUNT(*) AS n FROM ordenes WHERE cliente_id = ?', [clienteId]))[0][0].n;
  assert.equal(despues, antes);
});

test('flujo completo: pago, orden pagada y boletos sin duplicar', { skip: omitir }, async () => {
  const { orden_id, total } = await nuevaOrden();
  const pago = await mysql.registrarPago({ ordenId: orden_id, monto: total, metodo: 'tarjeta', estado: 'aprobado', referencia: 'REF1' });
  assert.ok(pago > 0);

  assert.equal(await mysql.marcarOrdenPagada(orden_id), true);
  assert.equal(await mysql.marcarOrdenPagada(orden_id), true, 'repetirlo no es un error');
  assert.equal(await mysql.cancelarOrden(orden_id), false, 'una orden pagada no se cancela');

  const boletos = await mysql.emitirBoletos(orden_id);
  assert.equal(boletos.length, 2);
  assert.equal(boletos[0].codigo_qr.length, 32);
  const otra = await mysql.emitirBoletos(orden_id);
  assert.deepEqual(otra.map((b) => b.codigo_qr), boletos.map((b) => b.codigo_qr));
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM boletos WHERE orden_id = ?', [orden_id]);
  assert.equal(n, 2);
});

test('emitirBoletos: una orden pendiente no emite', { skip: omitir }, async () => {
  const { orden_id } = await nuevaOrden();
  await assert.rejects(mysql.emitirBoletos(orden_id), /no está pagada/);
});

test('cancelar y expirar solo valen desde pendiente', { skip: omitir }, async () => {
  const a = (await nuevaOrden()).orden_id;
  assert.equal(await mysql.cancelarOrden(a), true);
  assert.equal(await mysql.marcarOrdenPagada(a), false);
  assert.equal(await estadoDe(a), 'cancelada');

  const b = (await nuevaOrden()).orden_id;
  assert.equal(await mysql.expirarOrden(b), true);
  assert.equal(await estadoDe(b), 'expirada');
});

test('marcarBoletoUsado: válido una vez, luego no válido, y QR desconocido', { skip: omitir }, async () => {
  const { orden_id } = await nuevaOrden();
  await mysql.marcarOrdenPagada(orden_id);
  const [boleto] = await mysql.emitirBoletos(orden_id);

  const primero = await mysql.marcarBoletoUsado(boleto.codigo_qr);
  assert.deepEqual(primero, { resultado: 'valido', boleto_id: boleto.boleto_id });
  const segundo = await mysql.marcarBoletoUsado(boleto.codigo_qr);
  assert.deepEqual(segundo, { resultado: 'no_valido', boleto_id: boleto.boleto_id, estado: 'usado' });
  assert.deepEqual(await mysql.marcarBoletoUsado('f'.repeat(32)), { resultado: 'no_existe' });
});

test('dos escaneos a la vez: solo uno es válido', { skip: omitir }, async () => {
  const { orden_id } = await nuevaOrden();
  await mysql.marcarOrdenPagada(orden_id);
  const [boleto] = await mysql.emitirBoletos(orden_id);
  const r = await Promise.all(Array.from({ length: 10 }, () => mysql.marcarBoletoUsado(boleto.codigo_qr)));
  assert.equal(r.filter((x) => x.resultado === 'valido').length, 1);
});
