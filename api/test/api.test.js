import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearApp } from '../src/app.js';
import { eventoId } from '../src/stubs/datos.js';

let servidor;
let base;
let mongoCaido = false;

before(async () => {
  const pings = {
    mysql: async () => {},
    postgres: async () => {},
    mongo: async () => { if (mongoCaido) throw new Error('caído'); },
  };
  servidor = crearApp({ pings }).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://localhost:${servidor.address().port}`;
});

after(() => servidor.close());

const pedir = async (ruta, cuerpo) => {
  const res = await fetch(base + ruta, cuerpo && {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const compra = (extra = {}) => ({
  cliente_id: 10, evento_id: eventoId(12), funcion_id: 12, sede_id: 2,
  asientos: [1001], metodo_pago: 'tarjeta', ...extra,
});

test('/health responde 200 con las tres bases', async () => {
  const r = await pedir('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { mysql: 'ok', postgres: 'ok', mongo: 'ok' });
});

test('/health responde 503 si una base falla', async () => {
  mongoCaido = true;
  const r = await pedir('/health');
  mongoCaido = false;
  assert.equal(r.status, 503);
  assert.equal(r.json.mongo, 'error');
  assert.equal(r.json.mysql, 'ok');
});

test('eventos: límite y filtro por categoría', async () => {
  assert.equal((await pedir('/api/eventos')).json.length, 20);
  assert.equal((await pedir('/api/eventos?limit=3')).json.length, 3);
  const teatro = (await pedir('/api/eventos?categoria=teatro&limit=5')).json;
  assert.ok(teatro.every((e) => e.categoria === 'teatro'));
  assert.equal((await pedir('/api/eventos?limit=0')).status, 400);
});

test('funciones y asientos exigen sus parámetros', async () => {
  assert.equal((await pedir('/api/funciones')).status, 400);
  assert.equal((await pedir('/api/funciones/12/asientos')).status, 400);
  assert.equal((await pedir('/api/funciones/12/asientos?sede_id=3')).status, 404);
  const funciones = (await pedir(`/api/funciones?evento_id=${eventoId(12)}`)).json;
  assert.equal(funciones[0].sede_id, 2);
  const asientos = (await pedir('/api/funciones/12/asientos?sede_id=2')).json;
  assert.equal(asientos[0].asiento_id, 1001);
});

test('compra: 201, y el mismo asiento después da 409', async () => {
  const a = await pedir('/api/compras', compra({ asientos: [1001, 1002] }));
  assert.equal(a.status, 201);
  assert.equal(a.json.estado, 'pagada');
  assert.equal(a.json.boletos.length, 2);
  assert.equal(a.json.boletos[0].codigo_qr.length, 32);

  const b = await pedir('/api/compras', compra({ asientos: [1002, 1003] }));
  assert.equal(b.status, 409);
  assert.deepEqual(b.json, { error: 'asiento_no_disponible', asientos: [1002] });

  const libres = (await pedir('/api/funciones/12/asientos?sede_id=2')).json.map((s) => s.asiento_id);
  assert.ok(!libres.includes(1001));
  assert.ok(libres.includes(1003));
});

test('compra: pago rechazado deja el asiento libre', async () => {
  const r = await pedir('/api/compras', compra({ cliente_id: 50, asientos: [1010] }));
  assert.equal(r.status, 402);
  assert.equal(r.json.error, 'pago_rechazado');
  const otra = await pedir('/api/compras', compra({ asientos: [1010] }));
  assert.equal(otra.status, 201);
});

test('compra: validaciones y recursos que no existen', async () => {
  assert.deepEqual((await pedir('/api/compras', compra({ asientos: [] }))).json, { error: 'peticion_invalida', campo: 'asientos' });
  assert.equal((await pedir('/api/compras', compra({ metodo_pago: 'oro' }))).json.campo, 'metodo_pago');
  assert.deepEqual((await pedir('/api/compras', compra({ cliente_id: 9000 }))).json, { error: 'no_encontrado', recurso: 'cliente' });
  assert.equal((await pedir('/api/compras', compra({ asientos: [5] }))).status, 400);
});

test('accesos: válido una vez, la segunda 409, desconocido 404', async () => {
  const c = await pedir('/api/compras', compra({ asientos: [1020] }));
  const qr = c.json.boletos[0].codigo_qr;
  const primero = await pedir('/api/accesos', { codigo_qr: qr, puerta: 'A' });
  assert.equal(primero.status, 200);
  assert.equal(primero.json.resultado, 'valido');
  const segundo = await pedir('/api/accesos', { codigo_qr: qr, puerta: 'A' });
  assert.deepEqual(segundo.json, { error: 'boleto_no_valido', estado: 'usado' });
  assert.equal((await pedir('/api/accesos', { codigo_qr: 'a'.repeat(32), puerta: 'A' })).status, 404);
});

test('reseñas: 201 y calificación fuera de rango da 400', async () => {
  const buena = await pedir('/api/resenas', { cliente_id: 10, evento_id: eventoId(5), calificacion: 5, comentario: 'Bien' });
  assert.equal(buena.status, 201);
  assert.equal(buena.json.resena_id.length, 24);
  assert.equal((await pedir('/api/resenas', { cliente_id: 10, evento_id: eventoId(5), calificacion: 6 })).json.campo, 'calificacion');
});

test('JSON roto y ruta desconocida', async () => {
  const roto = await fetch(base + '/api/compras', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(roto.status, 400);
  assert.equal((await pedir('/api/nada')).status, 404);
});

test('/metrics expone las métricas del contrato', async () => {
  const texto = await (await fetch(base + '/metrics')).text();
  assert.match(texto, /compras_total\{resultado="exitosa"\} [1-9]/);
  assert.match(texto, /compras_total\{resultado="asiento_no_disponible"\} [1-9]/);
  assert.match(texto, /compras_total\{resultado="pago_rechazado"\} [1-9]/);
  assert.match(texto, /compra_duracion_segundos_bucket/);
  assert.match(texto, /http_peticiones_total\{ruta="\/api\/compras",codigo="201"\}/);
  assert.match(texto, /process_cpu_user_seconds_total/);
});
