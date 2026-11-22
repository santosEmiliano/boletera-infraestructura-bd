import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pgPool as pool } from '../src/db.js';
import * as pg from '../src/modules/postgres/index.js';
import { expirarVencidas } from '../src/modules/postgres/expiracion.js';

// Usan la base real y crean sus propios datos en la sede 1: una zona, una
// función y 10 asientos con ids que el seed no usa (900001 a 900010). Al
// terminar los borran. Se corren con el usuario postgres, porque boletera_api
// no tiene DELETE.
const omitir = process.env.PRUEBAS_BD !== '1' && 'define PRUEBAS_BD=1 para correrlas';

const SEDE = 1;
const EVENTO = 'f'.repeat(24);
const IDS = Array.from({ length: 10 }, (_, i) => 900001 + i);
const [A1, A2, A3, A4] = IDS;
let zonaId;
let funcionId;
let ultimaOrden = 990000000;
const nuevaOrden = () => ++ultimaOrden;

const filas = async (sql, params) => (await pool.query(sql, params)).rows;
const estados = async (ids) => (await filas(
  'SELECT estado FROM asientos WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[]) ORDER BY asiento_id',
  [SEDE, ids],
)).map((r) => r.estado);
const reservasDe = (ordenId) => filas(
  'SELECT asiento_id::int, estado FROM reservas_asiento WHERE sede_id = $1 AND orden_id = $2 ORDER BY asiento_id',
  [SEDE, ordenId],
);
const movimientos = async (tipo) => (await filas(
  'SELECT count(*)::int AS n FROM movimientos_inventario WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[]) AND tipo = $3',
  [SEDE, IDS, tipo],
))[0].n;

async function limpiarInventario() {
  await pool.query('DELETE FROM movimientos_inventario WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[])', [SEDE, IDS]);
  await pool.query('DELETE FROM reservas_asiento WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[])', [SEDE, IDS]);
}

before(async () => {
  if (omitir) return;
  [{ zona_id: zonaId }] = await filas(
    "INSERT INTO zonas (sede_id, nombre, precio_base) VALUES ($1, 'Prueba automatica', 999.50) RETURNING zona_id",
    [SEDE],
  );
  [{ funcion_id: funcionId }] = await filas(
    "INSERT INTO funciones (evento_id, sede_id, fecha_hora) VALUES ($1, $2, now() + interval '30 days') RETURNING funcion_id",
    [EVENTO, SEDE],
  );
  await pool.query(
    `INSERT INTO asientos (asiento_id, sede_id, funcion_id, zona_id, fila, numero)
     SELECT id, $1, $2, $3, 'ZZ', id - 900000 FROM unnest($4::bigint[]) AS id`,
    [SEDE, funcionId, zonaId, IDS],
  );
});

beforeEach(async () => {
  if (omitir) return;
  await limpiarInventario();
  await pool.query("UPDATE asientos SET estado = 'libre' WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[])", [SEDE, IDS]);
});

after(async () => {
  if (omitir) return;
  await limpiarInventario();
  await pool.query('DELETE FROM asientos WHERE sede_id = $1 AND asiento_id = ANY($2::bigint[])', [SEDE, IDS]);
  await pool.query('DELETE FROM funciones WHERE funcion_id = $1', [funcionId]);
  await pool.query('DELETE FROM zonas WHERE zona_id = $1', [zonaId]);
  await pool.end();
});

test('consultas: funciones y asientos libres con la forma del contrato', { skip: omitir }, async () => {
  const [funcion] = await pg.listarFunciones(EVENTO);
  assert.equal(funcion.funcion_id, funcionId);
  assert.equal(funcion.sede_id, SEDE);
  assert.equal(funcion.sede, 'Aguascalientes');
  assert.equal(funcion.asientos_libres, 10);
  assert.ok(funcion.fecha instanceof Date);

  const libres = await pg.asientosLibres(funcionId, SEDE);
  assert.equal(libres.length, 10);
  assert.deepEqual(libres[0], { asiento_id: A1, zona: 'Prueba automatica', precio: 999.5 });
  assert.equal(await pg.asientosLibres(funcionId, 2), null);

  assert.equal((await pg.obtenerFuncion(funcionId)).sede_id, SEDE);
  assert.equal(await pg.obtenerFuncion(2147483000), null);
});

test('obtenerAsientos: solo devuelve los que son de la función', { skip: omitir }, async () => {
  const asientos = await pg.obtenerAsientos({ sedeId: SEDE, funcionId, asientos: [A1, A2, 1] });
  assert.deepEqual(asientos.map((a) => a.asiento_id), [A1, A2]);
  assert.equal(asientos[0].estado, 'libre');
});

test('reservarAsientos: reserva, crea las reservas y los movimientos', { skip: omitir }, async () => {
  const orden = nuevaOrden();
  const r = await pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: orden, asientos: [A1, A2] });
  assert.equal(r.reservado, true);
  const minutos = (r.expira_en - Date.now()) / 60000;
  assert.ok(minutos > 8 && minutos < 11, `vence en ${minutos} minutos`);
  assert.deepEqual(await estados([A1, A2]), ['reservado', 'reservado']);
  assert.deepEqual((await reservasDe(orden)).map((x) => x.estado), ['activa', 'activa']);
  assert.equal(await movimientos('reserva'), 2);
});

test('reservarAsientos: si falta uno no reserva ninguno', { skip: omitir }, async () => {
  await pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: nuevaOrden(), asientos: [A1] });
  const orden = nuevaOrden();
  const r = await pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: orden, asientos: [A1, A2] });
  assert.deepEqual(r, { reservado: false, no_disponibles: [A1] });
  assert.deepEqual(await estados([A2]), ['libre']);
  assert.deepEqual(await reservasDe(orden), []);
  assert.equal(await movimientos('reserva'), 1);
});

test('confirmarVenta: vende, y repetirla no duplica', { skip: omitir }, async () => {
  const orden = nuevaOrden();
  await pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: orden, asientos: [A1, A2] });
  assert.equal(await pg.confirmarVenta({ sedeId: SEDE, ordenId: orden }), true);
  assert.equal(await pg.confirmarVenta({ sedeId: SEDE, ordenId: orden }), true);
  assert.deepEqual(await estados([A1, A2]), ['vendido', 'vendido']);
  assert.deepEqual((await reservasDe(orden)).map((x) => x.estado), ['confirmada', 'confirmada']);
  assert.equal(await movimientos('venta'), 2);
  assert.equal(await pg.confirmarVenta({ sedeId: SEDE, ordenId: nuevaOrden() }), false);
});

test('liberarReserva: devuelve los asientos y no deshace una venta', { skip: omitir }, async () => {
  const orden = nuevaOrden();
  await pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: orden, asientos: [A1, A2] });
  assert.equal(await pg.liberarReserva({ sedeId: SEDE, ordenId: orden }), 2);
  assert.equal(await pg.liberarReserva({ sedeId: SEDE, ordenId: orden }), 0);
  assert.deepEqual(await estados([A1, A2]), ['libre', 'libre']);
  assert.deepEqual((await reservasDe(orden)).map((x) => x.estado), ['cancelada', 'cancelada']);
  assert.equal(await movimientos('liberacion'), 2);
  assert.equal(await pg.confirmarVenta({ sedeId: SEDE, ordenId: orden }), false);

  const vendida = nuevaOrden();
  await pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: vendida, asientos: [A3] });
  await pg.confirmarVenta({ sedeId: SEDE, ordenId: vendida });
  assert.equal(await pg.liberarReserva({ sedeId: SEDE, ordenId: vendida }), 0);
  assert.deepEqual(await estados([A3]), ['vendido']);
});

// Ojo: expirarVencidas también vence cualquier otra reserva vencida de la base
// (por ejemplo, las pendientes del seed), igual que la API al arrancar.
test('expirarVencidas: libera la reserva vencida y ya no se puede confirmar', { skip: omitir }, async () => {
  const orden = nuevaOrden();
  await pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: orden, asientos: [A1, A2] });
  await pool.query("UPDATE reservas_asiento SET expira_en = now() - interval '1 minute' WHERE sede_id = $1 AND orden_id = $2", [SEDE, orden]);

  assert.ok((await expirarVencidas()).includes(orden));
  assert.deepEqual(await estados([A1, A2]), ['libre', 'libre']);
  assert.deepEqual((await reservasDe(orden)).map((x) => x.estado), ['expirada', 'expirada']);
  assert.equal(await movimientos('liberacion'), 2);
  assert.equal(await pg.confirmarVenta({ sedeId: SEDE, ordenId: orden }), false);
});

test('50 compras a la vez del mismo asiento: solo una lo reserva', { skip: omitir }, async () => {
  const intentos = Array.from({ length: 50 }, () =>
    pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: nuevaOrden(), asientos: [A1] }));
  const resultados = await Promise.all(intentos);
  assert.equal(resultados.filter((r) => r.reservado).length, 1);
  assert.equal(resultados.filter((r) => !r.reservado).length, 49);
  const [{ n }] = await filas('SELECT count(*)::int AS n FROM reservas_asiento WHERE sede_id = $1 AND asiento_id = $2', [SEDE, A1]);
  assert.equal(n, 1);
});

test('compras cruzadas ([3,4] contra [4,3]): una gana y ninguna truena', { skip: omitir }, async () => {
  const intentos = Array.from({ length: 20 }, (_, i) =>
    pg.reservarAsientos({ sedeId: SEDE, funcionId, ordenId: nuevaOrden(), asientos: i % 2 ? [A3, A4] : [A4, A3] }));
  const resultados = await Promise.all(intentos);
  assert.equal(resultados.filter((r) => r.reservado).length, 1);
  assert.deepEqual(await estados([A3, A4]), ['reservado', 'reservado']);
});
