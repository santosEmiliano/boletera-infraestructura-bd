import { ObjectId } from 'mongodb';
import { mongo } from '../../db.js';
import { marcarBoletoUsado } from '../mysql/index.js';

const coleccion = (nombre) => mongo.db().collection(nombre);

const ID_EVENTO = /^[0-9a-f]{24}$/;

const aEvento = (doc) => ({
  evento_id: doc._id.toHexString(),
  nombre: doc.nombre,
  categoria: doc.categoria,
  descripcion: doc.descripcion,
});

// GET /api/eventos
export async function listarEventos({ categoria, limit = 20 } = {}) {
  const filtro = categoria ? { categoria } : {};
  const docs = await coleccion('eventos').find(filtro).sort({ _id: 1 }).limit(limit).toArray();
  return docs.map(aEvento);
}

// Paso 1 de la compra: null si el evento no existe
export async function obtenerEvento(eventoId) {
  if (!ID_EVENTO.test(eventoId)) return null;
  const doc = await coleccion('eventos').findOne({ _id: new ObjectId(eventoId) });
  return doc ? aEvento(doc) : null;
}

// Paso 6 de la compra
export async function registrarActividad({ clienteId, tipo, eventoId, ordenId }) {
  await coleccion('actividad_usuarios').insertOne({
    cliente_id: clienteId,
    tipo,
    evento_id: new ObjectId(eventoId),
    orden_id: ordenId,
    fecha: new Date(),
  });
}

// Paso 6 de la compra
export async function enviarNotificacion({ clienteId, ordenId, tipo = 'confirmacion', mensaje }) {
  await coleccion('notificaciones').insertOne({
    cliente_id: clienteId,
    tipo,
    orden_id: ordenId,
    mensaje,
    leida: false,
    creada_en: new Date(),
  });
}

// POST /api/resenas. Devuelve el _id de la reseña como texto.
export async function crearResena({ clienteId, eventoId, calificacion, comentario }) {
  const { insertedId } = await coleccion('resenas').insertOne({
    cliente_id: clienteId,
    evento_id: new ObjectId(eventoId),
    calificacion,
    comentario: comentario ?? null,
    creada_en: new Date(),
  });
  return insertedId.toHexString();
}

// POST /api/accesos. La decisión la toma MySQL (marcarBoletoUsado) y cada intento,
// válido o no, queda en bitacora_accesos.
export async function registrarAcceso({ codigoQr, puerta }) {
  const acceso = await marcarBoletoUsado(codigoQr);
  try {
    await coleccion('bitacora_accesos').insertOne({
      codigo_qr: codigoQr,
      puerta,
      resultado: acceso.resultado,
      boleto_id: acceso.boleto_id ?? null,
      fecha: new Date(),
    });
  } catch (e) {
    console.error('bitácora de accesos:', e.message);
  }
  return acceso;
}
