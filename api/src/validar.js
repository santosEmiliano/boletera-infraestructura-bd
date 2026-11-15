import { peticionInvalida } from './errores.js';

const entero = (v) => Number.isInteger(v) && v > 0;
const idMongo = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v);
const METODOS = ['tarjeta', 'transferencia', 'efectivo'];

export function validarCompra(b) {
  if (!b || typeof b !== 'object') throw peticionInvalida('cuerpo');
  if (!entero(b.cliente_id)) throw peticionInvalida('cliente_id');
  if (!idMongo(b.evento_id)) throw peticionInvalida('evento_id');
  if (!entero(b.funcion_id)) throw peticionInvalida('funcion_id');
  if (!entero(b.sede_id)) throw peticionInvalida('sede_id');
  const a = b.asientos;
  if (!Array.isArray(a) || a.length === 0 || !a.every(entero) || new Set(a).size !== a.length) {
    throw peticionInvalida('asientos');
  }
  if (!METODOS.includes(b.metodo_pago)) throw peticionInvalida('metodo_pago');
  if (b.factura !== undefined && typeof b.factura !== 'boolean') throw peticionInvalida('factura');
}

export function validarAcceso(b) {
  if (!b || typeof b !== 'object') throw peticionInvalida('cuerpo');
  if (typeof b.codigo_qr !== 'string' || !/^[0-9a-f]{32}$/.test(b.codigo_qr)) throw peticionInvalida('codigo_qr');
  if (typeof b.puerta !== 'string' || b.puerta.trim() === '') throw peticionInvalida('puerta');
}

export function validarResena(b) {
  if (!b || typeof b !== 'object') throw peticionInvalida('cuerpo');
  if (!entero(b.cliente_id)) throw peticionInvalida('cliente_id');
  if (!idMongo(b.evento_id)) throw peticionInvalida('evento_id');
  if (!Number.isInteger(b.calificacion) || b.calificacion < 1 || b.calificacion > 5) throw peticionInvalida('calificacion');
  if (b.comentario !== undefined && (typeof b.comentario !== 'string' || b.comentario.length > 500)) {
    throw peticionInvalida('comentario');
  }
}

export function enteroDeConsulta(valor, campo) {
  const n = Number(valor);
  if (valor === undefined || !Number.isInteger(n) || n < 1) throw peticionInvalida(campo);
  return n;
}
