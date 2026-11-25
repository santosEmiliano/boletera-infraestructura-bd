import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorHttp } from '../src/errores.js';
import { crearCompras, esTransitorio } from '../src/compras.js';
import { crearFalsos, eventoId } from '../test-utils/falsos.js';

// Función 12 es de la sede 2 y sus asientos empiezan en el 1001
const compra = (extra = {}) => ({
  cliente_id: 10, evento_id: eventoId(12), funcion_id: 12, sede_id: 2,
  asientos: [1001, 1002], metodo_pago: 'tarjeta', ...extra,
});

function nuevo() {
  const f = crearFalsos();
  const orquestador = crearCompras(f, { reintentos: { esperaMs: 0 } });
  const ultimaOrden = () => f.estado.ordenes.get([...f.estado.ordenes.keys()].at(-1));
  return { f, orquestador, ultimaOrden };
}

const transitorio = () => Object.assign(new Error('conexión caída'), { code: 'ECONNRESET' });
const falla = (status, error) => (e) => e instanceof ErrorHttp && e.status === status && e.cuerpo.error === error;

test('compra completa: orden pagada, asientos vendidos, boletos y avisos en Mongo', async () => {
  const { f, orquestador, ultimaOrden } = nuevo();
  const r = await orquestador.comprar(compra());
  assert.equal(r.estado, 'pagada');
  assert.equal(r.total, 5000);
  assert.equal(r.boletos.length, 2);
  assert.equal(ultimaOrden().estado, 'pagada');
  assert.equal(f.estado.estadoDe(2, 1001), 'vendido');
  assert.equal(f.estado.pagos[0].estado, 'aprobado');
  assert.equal(f.estado.mongoDocs.actividad.length, 1);
  assert.equal(f.estado.mongoDocs.notificaciones.length, 1);
});

test('asiento ocupado: 409, orden cancelada y el otro asiento queda libre', async () => {
  const { f, orquestador, ultimaOrden } = nuevo();
  await orquestador.comprar(compra({ asientos: [1002] }));
  await assert.rejects(orquestador.comprar(compra({ cliente_id: 11, asientos: [1001, 1002] })), (e) => {
    assert.deepEqual(e.cuerpo, { error: 'asiento_no_disponible', asientos: [1002] });
    return e.status === 409;
  });
  assert.equal(ultimaOrden().estado, 'cancelada');
  assert.equal(f.estado.estadoDe(2, 1001), 'libre');
  assert.equal(f.estado.pagos.length, 1, 'no se cobró la compra rechazada');
});

test('pago rechazado: 402, asientos liberados y orden cancelada', async () => {
  const { f, orquestador, ultimaOrden } = nuevo();
  await assert.rejects(orquestador.comprar(compra({ cliente_id: 50 })), (e) => {
    assert.equal(e.cuerpo.error, 'pago_rechazado');
    assert.equal(e.cuerpo.orden_id, [...f.estado.ordenes.keys()].at(-1));
    return e.status === 402;
  });
  assert.equal(ultimaOrden().estado, 'cancelada');
  assert.equal(f.estado.estadoDe(2, 1001), 'libre');
  assert.equal(f.estado.pagos[0].estado, 'rechazado');
  assert.equal(f.estado.boletos.size, 0);
});

test('si la reserva venció antes de confirmar: 409 y no se emiten boletos', async (t) => {
  const { f, orquestador, ultimaOrden } = nuevo();
  t.mock.method(f.postgres, 'confirmarVenta', async () => false);
  await assert.rejects(orquestador.comprar(compra()), falla(409, 'asiento_no_disponible'));
  assert.equal(ultimaOrden().estado, 'cancelada');
  assert.equal(f.estado.boletos.size, 0);
});

test('validaciones: cliente, evento y función que no existen dan 404', async () => {
  const { orquestador } = nuevo();
  await assert.rejects(orquestador.comprar(compra({ cliente_id: 9000 })), falla(404, 'no_encontrado'));
  await assert.rejects(orquestador.comprar(compra({ evento_id: eventoId(700) })), (e) => e.cuerpo.recurso === 'evento');
  await assert.rejects(orquestador.comprar(compra({ funcion_id: 99 })), (e) => e.cuerpo.recurso === 'funcion');
  await assert.rejects(orquestador.comprar(compra({ sede_id: 3 })), (e) => e.cuerpo.recurso === 'funcion');
  await assert.rejects(orquestador.comprar(compra({ evento_id: eventoId(13) })), (e) => e.cuerpo.recurso === 'funcion');
});

test('un asiento que no es de la función da 400 y no crea orden', async () => {
  const { f, orquestador } = nuevo();
  await assert.rejects(orquestador.comprar(compra({ asientos: [5] })), (e) => e.status === 400 && e.cuerpo.campo === 'asientos');
  assert.equal(f.estado.ordenes.size, 0);
});

test('un error pasajero se reintenta y la compra sale bien', async (t) => {
  const { f, orquestador } = nuevo();
  const original = f.postgres.reservarAsientos;
  let llamadas = 0;
  t.mock.method(f.postgres, 'reservarAsientos', async (...args) => {
    if (++llamadas <= 2) throw transitorio();
    return original(...args);
  });
  const r = await orquestador.comprar(compra());
  assert.equal(r.estado, 'pagada');
  assert.equal(llamadas, 3);
});

test('si el error pasajero no cede en 3 intentos, se deshace todo', async (t) => {
  const { f, orquestador, ultimaOrden } = nuevo();
  const reservar = t.mock.method(f.postgres, 'reservarAsientos', async () => { throw transitorio(); });
  const liberar = t.mock.method(f.postgres, 'liberarReserva');
  t.mock.method(console, 'error', () => {});
  await assert.rejects(orquestador.comprar(compra()), (e) => e.code === 'ECONNRESET');
  assert.equal(reservar.mock.callCount(), 3);
  assert.equal(liberar.mock.callCount(), 1);
  assert.equal(ultimaOrden().estado, 'cancelada');
});

test('un error que no es pasajero no se reintenta', async (t) => {
  const { f, orquestador } = nuevo();
  const crear = t.mock.method(f.mysql, 'crearOrden', async () => { throw new Error('columna inválida'); });
  await assert.rejects(orquestador.comprar(compra()), /columna inválida/);
  assert.equal(crear.mock.callCount(), 1);
});

test('si falla el registro del pago se libera y se cancela', async (t) => {
  const { f, orquestador, ultimaOrden } = nuevo();
  t.mock.method(f.mysql, 'registrarPago', async () => { throw new Error('sin espacio'); });
  await assert.rejects(orquestador.comprar(compra()), /sin espacio/);
  assert.equal(ultimaOrden().estado, 'cancelada');
  assert.equal(f.estado.estadoDe(2, 1001), 'libre');
});

test('una compensación que falla no tapa el 402', async (t) => {
  const { f, orquestador } = nuevo();
  t.mock.method(f.mysql, 'cancelarOrden', async () => { throw new Error('mysql caído'); });
  const error = t.mock.method(console, 'error', () => {});
  await assert.rejects(orquestador.comprar(compra({ cliente_id: 100 })), falla(402, 'pago_rechazado'));
  assert.equal(f.estado.estadoDe(2, 1001), 'libre', 'liberó los asientos aunque no pudo cancelar');
  assert.match(error.mock.calls[0].arguments.join(' '), /cancelar la orden/);
});

test('si Mongo no responde, la compra sale igual', async (t) => {
  const { f, orquestador } = nuevo();
  t.mock.method(f.mongo, 'enviarNotificacion', async () => { throw new Error('mongo caído'); });
  t.mock.method(console, 'error', () => {});
  const r = await orquestador.comprar(compra());
  assert.equal(r.estado, 'pagada');
  assert.equal(f.estado.mongoDocs.actividad.length, 1);
});

test('escanear: válido, ya usado y QR inexistente', async () => {
  const { orquestador } = nuevo();
  const { boletos } = await orquestador.comprar(compra());
  const qr = boletos[0].codigo_qr;
  assert.equal((await orquestador.escanear({ codigo_qr: qr, puerta: 'A' })).resultado, 'valido');
  await assert.rejects(orquestador.escanear({ codigo_qr: qr, puerta: 'A' }), (e) => e.status === 409 && e.cuerpo.estado === 'usado');
  await assert.rejects(orquestador.escanear({ codigo_qr: 'a'.repeat(32), puerta: 'A' }), falla(404, 'qr_invalido'));
});

test('dejarResena: exige que existan el cliente y el evento', async () => {
  const { orquestador } = nuevo();
  const b = { cliente_id: 10, evento_id: eventoId(5), calificacion: 5 };
  assert.match((await orquestador.dejarResena(b)).resena_id, /^[0-9a-f]{24}$/);
  await assert.rejects(orquestador.dejarResena({ ...b, cliente_id: 9000 }), (e) => e.cuerpo.recurso === 'cliente');
  await assert.rejects(orquestador.dejarResena({ ...b, evento_id: eventoId(700) }), (e) => e.cuerpo.recurso === 'evento');
});

test('esTransitorio reconoce los errores de conexión de los tres motores', () => {
  assert.ok(esTransitorio({ code: 'ER_LOCK_DEADLOCK' }));
  assert.ok(esTransitorio({ code: '40P01' }));
  assert.ok(esTransitorio({ code: '08006' }));
  assert.ok(esTransitorio({ name: 'MongoServerSelectionError' }));
  assert.ok(esTransitorio(new Error('timeout exceeded when trying to connect')));
  assert.ok(!esTransitorio({ code: 'ER_DUP_ENTRY' }));
  assert.ok(!esTransitorio(new Error('otra cosa')));
});
