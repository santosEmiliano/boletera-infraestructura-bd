import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { mongo } from '../src/db.js';
import * as modulo from '../src/modules/mongo/index.js';

// Las pruebas necesitan un MongoDB y borran lo que crean, se corre con
//  PRUEBAS_BD=1 MONGO_URI=... npm test
// registrarAcceso sí necesita MySQL con el esquema cargado.
const omitir = process.env.PRUEBAS_BD !== '1' && 'define PRUEBAS_BD=1 para correrlas';

const cliente = 987654321;
const eventos = [
  { _id: new ObjectId(), nombre: 'Prueba A', categoria: 'prueba-a', descripcion: 'uno' },
  { _id: new ObjectId(), nombre: 'Prueba B', categoria: 'prueba-a', descripcion: 'dos' },
  { _id: new ObjectId(), nombre: 'Prueba C', categoria: 'prueba-b', descripcion: 'tres' },
];
const db = () => mongo.db();

before(async () => {
  if (omitir) return;
  await db().collection('eventos').insertMany(eventos);
});

after(async () => {
  if (omitir) return;
  await db().collection('eventos').deleteMany({ _id: { $in: eventos.map((e) => e._id) } });
  for (const c of ['resenas', 'actividad_usuarios', 'notificaciones']) {
    await db().collection(c).deleteMany({ cliente_id: cliente });
  }
  await db().collection('bitacora_accesos').deleteMany({ puerta: 'prueba-automatica' });
  await mongo.close();
});

test('listarEventos: filtra por categoría y respeta el límite', { skip: omitir }, async () => {
  const a = await modulo.listarEventos({ categoria: 'prueba-a' });
  assert.deepEqual(a.map((e) => e.nombre), ['Prueba A', 'Prueba B']);
  assert.equal(a[0].evento_id, eventos[0]._id.toHexString());
  assert.equal((await modulo.listarEventos({ categoria: 'prueba-a', limit: 1 })).length, 1);
  assert.deepEqual(await modulo.listarEventos({ categoria: 'no-existe' }), []);
});

test('obtenerEvento: lo encuentra, y devuelve null si no existe o el id no es válido', { skip: omitir }, async () => {
  const e = await modulo.obtenerEvento(eventos[2]._id.toHexString());
  assert.equal(e.nombre, 'Prueba C');
  assert.equal(await modulo.obtenerEvento('f'.repeat(24)), null);
  assert.equal(await modulo.obtenerEvento('no-es-un-id'), null);
  assert.equal(await modulo.obtenerEvento('123456789012'), null, 'doce caracteres no son un id nuestro');
});

test('crearResena: guarda el documento y devuelve su id', { skip: omitir }, async () => {
  const id = await modulo.crearResena({ clienteId: cliente, eventoId: eventos[0]._id.toHexString(), calificacion: 4, comentario: 'Bien' });
  assert.match(id, /^[0-9a-f]{24}$/);
  const doc = await db().collection('resenas').findOne({ _id: new ObjectId(id) });
  assert.equal(doc.calificacion, 4);
  assert.equal(doc.cliente_id, cliente);
  assert.ok(doc.evento_id.equals(eventos[0]._id));

  const sinComentario = await modulo.crearResena({ clienteId: cliente, eventoId: eventos[0]._id.toHexString(), calificacion: 5 });
  assert.equal((await db().collection('resenas').findOne({ _id: new ObjectId(sinComentario) })).comentario, null);
});

test('registrarActividad y enviarNotificacion guardan lo de la compra', { skip: omitir }, async () => {
  const eventoId = eventos[1]._id.toHexString();
  await modulo.registrarActividad({ clienteId: cliente, tipo: 'compra', eventoId, ordenId: 77 });
  await modulo.enviarNotificacion({ clienteId: cliente, ordenId: 77, mensaje: 'Tu compra está confirmada' });

  const act = await db().collection('actividad_usuarios').findOne({ cliente_id: cliente });
  assert.equal(act.tipo, 'compra');
  assert.equal(act.orden_id, 77);
  assert.ok(act.evento_id.equals(eventos[1]._id));

  const not = await db().collection('notificaciones').findOne({ cliente_id: cliente });
  assert.equal(not.tipo, 'confirmacion');
  assert.equal(not.leida, false);
});
