import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { crearApp } from '../src/app.js';
import { mongo, mysqlPool, pgPool } from '../src/db.js';

// La compra completa contra las tres bases reales. Crea sus propios datos
// (un evento, una función con 6 asientos en la sede 1 y tres clientes) y los
// borra al terminar. Necesita permisos de DELETE en MySQL y PostgreSQL:
//  PRUEBAS_BD=1 MYSQL_USER=... MYSQL_PASSWORD=... PG_USER=postgres PG_PASSWORD=... \
//  MONGO_URI=... node --test test/compra.integracion.test.js
const omitir = process.env.PRUEBAS_BD !== '1' && 'define PRUEBAS_BD=1 para correrlas';

const SEDE = 1;
const ASIENTOS = [910001, 910002, 910003, 910004, 910005, 910006];
const PUERTA = 'integracion';
const eventoOid = new ObjectId();
const EVENTO = eventoOid.toHexString();
const CLIENTES = { normal: 9100001, otro: 9100002, rechazado: 9100050 };
let funcionId;
let zonaId;
let servidor;
let base;

const pedir = async (ruta, cuerpo) => {
  const res = await fetch(base + ruta, cuerpo && {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const comprar = (cliente, asientos) => pedir('/api/compras', {
  cliente_id: cliente, evento_id: EVENTO, funcion_id: funcionId, sede_id: SEDE, asientos, metodo_pago: 'tarjeta',
});
const estadoAsiento = async (id) => (await pgPool.query(
  'SELECT estado FROM asientos WHERE sede_id = $1 AND asiento_id = $2', [SEDE, id],
)).rows[0].estado;
const ordenDe = async (id) => (await mysqlPool.execute('SELECT estado, total FROM ordenes WHERE orden_id = ?', [id]))[0][0];

before(async () => {
  if (omitir) return;
  await mongo.db().collection('eventos').insertOne({ _id: eventoOid, nombre: 'Prueba integracion', categoria: 'prueba', descripcion: 'x' });
  ({ rows: [{ zona_id: zonaId }] } = await pgPool.query(
    "INSERT INTO zonas (sede_id, nombre, precio_base) VALUES ($1, 'Prueba integracion', 100.25) RETURNING zona_id", [SEDE],
  ));
  ({ rows: [{ funcion_id: funcionId }] } = await pgPool.query(
    "INSERT INTO funciones (evento_id, sede_id, fecha_hora) VALUES ($1, $2, now() + interval '30 days') RETURNING funcion_id",
    [EVENTO, SEDE],
  ));
  await pgPool.query(
    `INSERT INTO asientos (asiento_id, sede_id, funcion_id, zona_id, fila, numero)
     SELECT id, $1, $2, $3, 'ZZ', id - 910000 FROM unnest($4::bigint[]) AS id`,
    [SEDE, funcionId, zonaId, ASIENTOS],
  );
  for (const id of Object.values(CLIENTES)) {
    await mysqlPool.execute('INSERT INTO clientes_contacto (cliente_id, nombre, apellidos, email) VALUES (?, ?, ?, ?)',
      [id, 'Prueba', 'Integracion', `integracion-${id}@example.com`]);
  }
  servidor = crearApp({ pings: {} }).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://localhost:${servidor.address().port}`;
});

after(async () => {
  if (omitir) return;
  servidor.close();
  const ids = Object.values(CLIENTES);
  const [ordenes] = await mysqlPool.query('SELECT orden_id FROM ordenes WHERE cliente_id IN (?)', [ids]);
  for (const { orden_id } of ordenes) {
    for (const tabla of ['boletos', 'pagos', 'orden_detalle', 'ordenes']) {
      await mysqlPool.execute(`DELETE FROM ${tabla} WHERE orden_id = ?`, [orden_id]);
    }
  }
  await mysqlPool.query('DELETE FROM clientes_contacto WHERE cliente_id IN (?)', [ids]);
  await pgPool.query('DELETE FROM movimientos_inventario WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[])', [SEDE, ASIENTOS]);
  await pgPool.query('DELETE FROM reservas_asiento WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[])', [SEDE, ASIENTOS]);
  await pgPool.query('DELETE FROM asientos WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[])', [SEDE, ASIENTOS]);
  await pgPool.query('DELETE FROM funciones WHERE funcion_id = $1', [funcionId]);
  await pgPool.query('DELETE FROM zonas WHERE zona_id = $1', [zonaId]);
  const db = mongo.db();
  await db.collection('eventos').deleteOne({ _id: eventoOid });
  await db.collection('actividad_usuarios').deleteMany({ cliente_id: { $in: ids } });
  await db.collection('notificaciones').deleteMany({ cliente_id: { $in: ids } });
  await db.collection('bitacora_accesos').deleteMany({ puerta: PUERTA });
  await Promise.allSettled([mysqlPool.end(), pgPool.end(), mongo.close()]);
});

test('compra: queda pagada en MySQL, vendida en PostgreSQL y avisada en MongoDB', { skip: omitir }, async () => {
  const r = await comprar(CLIENTES.normal, [ASIENTOS[0], ASIENTOS[1]]);
  assert.equal(r.status, 201);
  assert.equal(r.json.total, 200.5);
  assert.equal(r.json.boletos.length, 2);
  assert.equal((await ordenDe(r.json.orden_id)).estado, 'pagada');
  assert.equal(await estadoAsiento(ASIENTOS[0]), 'vendido');
  const [[pago]] = await mysqlPool.execute('SELECT estado, monto FROM pagos WHERE orden_id = ?', [r.json.orden_id]);
  assert.deepEqual([pago.estado, pago.monto], ['aprobado', 200.5]);
  const db = mongo.db();
  assert.equal(await db.collection('actividad_usuarios').countDocuments({ cliente_id: CLIENTES.normal, orden_id: r.json.orden_id }), 1);
  assert.equal(await db.collection('notificaciones').countDocuments({ cliente_id: CLIENTES.normal, orden_id: r.json.orden_id }), 1);

  const libres = (await pedir(`/api/funciones/${funcionId}/asientos?sede_id=${SEDE}`)).json.map((a) => a.asiento_id);
  assert.ok(!libres.includes(ASIENTOS[0]));
  assert.ok(libres.includes(ASIENTOS[2]));

  const qr = r.json.boletos[0].codigo_qr;
  assert.equal((await pedir('/api/accesos', { codigo_qr: qr, puerta: PUERTA })).status, 200);
  assert.equal((await pedir('/api/accesos', { codigo_qr: qr, puerta: PUERTA })).status, 409);
  assert.equal(await db.collection('bitacora_accesos').countDocuments({ codigo_qr: qr }), 2);
});

test('el asiento vendido da 409, la orden queda cancelada y el otro asiento libre', { skip: omitir }, async () => {
  const r = await comprar(CLIENTES.otro, [ASIENTOS[1], ASIENTOS[2]]);
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'asiento_no_disponible', asientos: [ASIENTOS[1]] });
  assert.equal(await estadoAsiento(ASIENTOS[2]), 'libre');
  const [[orden]] = await mysqlPool.execute(
    'SELECT estado FROM ordenes WHERE cliente_id = ? ORDER BY orden_id DESC LIMIT 1', [CLIENTES.otro],
  );
  assert.equal(orden.estado, 'cancelada');
});

test('pago rechazado: 402, asiento libre y orden cancelada', { skip: omitir }, async () => {
  const r = await comprar(CLIENTES.rechazado, [ASIENTOS[3]]);
  assert.equal(r.status, 402);
  assert.equal((await ordenDe(r.json.orden_id)).estado, 'cancelada');
  assert.equal(await estadoAsiento(ASIENTOS[3]), 'libre');
  const [[pago]] = await mysqlPool.execute('SELECT estado FROM pagos WHERE orden_id = ?', [r.json.orden_id]);
  assert.equal(pago.estado, 'rechazado');
});

test('cinco compras a la vez del mismo asiento: una gana y nada se vende dos veces', { skip: omitir }, async () => {
  const respuestas = await Promise.all(Array.from({ length: 5 }, () => comprar(CLIENTES.otro, [ASIENTOS[4]])));
  const estados = respuestas.map((r) => r.status).sort();
  assert.deepEqual(estados, [201, 409, 409, 409, 409]);
  const [[{ n }]] = await mysqlPool.execute(
    'SELECT COUNT(*) AS n FROM boletos WHERE sede_id = ? AND asiento_id = ?', [SEDE, ASIENTOS[4]],
  );
  assert.equal(n, 1);
  const { rows: [{ n: reservas }] } = await pgPool.query(
    "SELECT count(*)::int AS n FROM reservas_asiento WHERE sede_id = $1 AND asiento_id = $2 AND estado = 'confirmada'", [SEDE, ASIENTOS[4]],
  );
  assert.equal(reservas, 1);
});

test('evento y reseña viven en MongoDB', { skip: omitir }, async () => {
  const eventos = (await pedir('/api/eventos?categoria=prueba')).json;
  assert.equal(eventos[0].evento_id, EVENTO);
  const funciones = (await pedir(`/api/funciones?evento_id=${EVENTO}`)).json;
  assert.equal(funciones[0].funcion_id, funcionId);
  const resena = await pedir('/api/resenas', { cliente_id: CLIENTES.normal, evento_id: EVENTO, calificacion: 5 });
  assert.equal(resena.status, 201);
  await mongo.db().collection('resenas').deleteOne({ _id: new ObjectId(resena.json.resena_id) });
});
