// Datos de ejemplo mientras no existen los módulos reales de cada motor.
// Siguen las mismas reglas que los seeds (ver mysql/seed/README.md).
import { randomUUID, randomBytes } from 'node:crypto';
import { ErrorHttp, noEncontrado, peticionInvalida } from '../errores.js';

const SEDES = { 1: 'Ciudad de México', 2: 'Guadalajara', 3: 'Monterrey', 4: 'Aguascalientes' };
const CATEGORIAS = ['concierto', 'teatro', 'deportes', 'festival'];
const ZONAS = [
  { nombre: 'VIP', hasta: 100, precio: 1800 },
  { nombre: 'Preferente', hasta: 350, precio: 1200 },
  { nombre: 'General', hasta: 700, precio: 850 },
  { nombre: 'Balcón', hasta: 1000, precio: 500 },
];

const vendidos = new Set();
const boletos = new Map();
let ultimaOrden = 90000;
let ultimoBoleto = 55000;

export const eventoId = (n) => n.toString(16).padStart(24, '0');
const numeroDeEvento = (id) => parseInt(id, 16);
const sedeDe = (f) => Math.ceil(f / 10);
const asientoId = (f, pos) => ((f - 1) % 10) * 1000 + pos + 1;
const posDeAsiento = (f, asiento) => asiento - 1 - ((f - 1) % 10) * 1000;
const zonaDe = (pos) => ZONAS.find((z) => pos < z.hasta);

export const existeCliente = (id) => id >= 1 && id <= 8000;
export const existeEvento = (id) => numeroDeEvento(id) >= 1 && numeroDeEvento(id) <= 600;

export function listarEventos(categoria, limit) {
  const lista = [];
  for (let n = 1; n <= 600 && lista.length < limit; n++) {
    const cat = CATEGORIAS[n % CATEGORIAS.length];
    if (categoria && categoria !== cat) continue;
    lista.push({ evento_id: eventoId(n), nombre: `Evento ${n}`, categoria: cat, descripcion: 'Evento de ejemplo' });
  }
  return lista;
}

function libres(funcion) {
  const sede = sedeDe(funcion);
  const salida = [];
  for (let pos = 0; pos < 1000; pos++) {
    const id = asientoId(funcion, pos);
    if (vendidos.has(`${sede}:${id}`)) continue;
    const z = zonaDe(pos);
    salida.push({ asiento_id: id, zona: z.nombre, precio: z.precio });
  }
  return salida;
}

export function listarFunciones(evento) {
  const n = numeroDeEvento(evento);
  if (n < 1 || n > 40) return [];
  return [{
    funcion_id: n,
    evento_id: evento,
    sede_id: sedeDe(n),
    sede: SEDES[sedeDe(n)],
    fecha: new Date(Date.UTC(2026, 11, 1 + n, 20)).toISOString(),
    asientos_libres: libres(n).length,
  }];
}

export function asientosLibres(funcion, sede) {
  if (funcion < 1 || funcion > 40 || sedeDe(funcion) !== sede) throw noEncontrado('funcion');
  return libres(funcion);
}

export function comprar(b) {
  if (!existeCliente(b.cliente_id)) throw noEncontrado('cliente');
  if (!existeEvento(b.evento_id)) throw noEncontrado('evento');
  if (b.funcion_id > 40 || sedeDe(b.funcion_id) !== b.sede_id) throw noEncontrado('funcion');

  const f = b.funcion_id;
  const precios = b.asientos.map((a) => {
    const pos = posDeAsiento(f, a);
    if (pos < 0 || pos >= 1000) throw peticionInvalida('asientos');
    return zonaDe(pos).precio;
  });

  const ocupados = b.asientos.filter((a) => vendidos.has(`${b.sede_id}:${a}`));
  if (ocupados.length) throw new ErrorHttp(409, { error: 'asiento_no_disponible', asientos: ocupados });

  const orden = ++ultimaOrden;
  // Los clientes múltiplos de 50 siempre tienen el pago rechazado
  if (b.cliente_id % 50 === 0) throw new ErrorHttp(402, { error: 'pago_rechazado', orden_id: orden });

  const emitidos = b.asientos.map((a) => {
    vendidos.add(`${b.sede_id}:${a}`);
    const boleto = {
      boleto_id: ++ultimoBoleto,
      sede_id: b.sede_id,
      asiento_id: a,
      codigo_qr: randomUUID().replaceAll('-', ''),
    };
    boletos.set(boleto.codigo_qr, { boleto_id: boleto.boleto_id, estado: 'emitido' });
    return boleto;
  });
  return { orden_id: orden, estado: 'pagada', total: precios.reduce((s, p) => s + p, 0), boletos: emitidos };
}

export function escanear(qr) {
  const boleto = boletos.get(qr);
  if (!boleto) throw new ErrorHttp(404, { error: 'qr_invalido' });
  if (boleto.estado !== 'emitido') throw new ErrorHttp(409, { error: 'boleto_no_valido', estado: boleto.estado });
  boleto.estado = 'usado';
  return { resultado: 'valido', boleto_id: boleto.boleto_id };
}

export function crearResena(b) {
  if (!existeCliente(b.cliente_id)) throw noEncontrado('cliente');
  if (!existeEvento(b.evento_id)) throw noEncontrado('evento');
  return { resena_id: randomBytes(12).toString('hex') };
}
