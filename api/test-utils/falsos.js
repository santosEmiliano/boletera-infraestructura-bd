// MySQL, PostgreSQL y MongoDB en memoria, con las mismas funciones que los
// módulos reales, para probar los endpoints y el orquestador sin bases de datos.
// Siguen las reglas de los seeds (ver mysql/seed/README.md).
import { randomUUID } from 'node:crypto';

const SEDES = { 1: 'Aguascalientes', 2: 'Ciudad de Mexico', 3: 'Guadalajara', 4: 'Monterrey' };
const CATEGORIAS = ['concierto', 'teatro', 'deportes', 'festival'];
const ZONAS = [
  { nombre: 'VIP Pista', precio: 2500 },
  { nombre: 'VIP Lateral', precio: 2000 },
  { nombre: 'Platino', precio: 1800 },
  { nombre: 'Oro', precio: 1500 },
  { nombre: 'Preferente A', precio: 1200 },
  { nombre: 'Preferente B', precio: 1000 },
  { nombre: 'General A', precio: 850 },
  { nombre: 'General B', precio: 700 },
  { nombre: 'Balcón A', precio: 500 },
  { nombre: 'Balcón B', precio: 400 },
];

export const eventoId = (n) => n.toString(16).padStart(24, '0');
const numeroDeEvento = (id) => parseInt(id, 16);
const sedeDe = (f) => Math.ceil(f / 10);
const posDeAsiento = (f, asiento) => asiento - 1 - ((f - 1) % 10) * 1000;
const asientoId = (f, pos) => ((f - 1) % 10) * 1000 + pos + 1;
const zonaDe = (pos) => ZONAS[Math.floor(pos / 100)];

export function crearFalsos() {
  // 'sede:asiento' -> { estado: 'reservado' | 'vendido', ordenId }
  const asientos = new Map();
  const ordenes = new Map();
  const pagos = [];
  const boletos = new Map();
  const mongoDocs = { actividad: [], notificaciones: [], resenas: [], bitacora: [] };
  let ultimaOrden = 90000;
  let ultimoBoleto = 55000;

  const clave = (sede, asiento) => `${sede}:${asiento}`;
  const estadoDe = (sede, asiento) => asientos.get(clave(sede, asiento))?.estado ?? 'libre';
  const delOrden = (sede, ordenId) => [...asientos].filter(([k, v]) => k.startsWith(`${sede}:`) && v.ordenId === ordenId);

  const mysql = {
    async obtenerCliente(id) {
      return id >= 1 && id <= 8000 ? { cliente_id: id, nombre: 'Cliente', apellidos: String(id) } : null;
    },
    async crearOrden({ clienteId, asientos: pedidos }) {
      const orden_id = ++ultimaOrden;
      const total = pedidos.reduce((s, a) => s + a.precio, 0);
      ordenes.set(orden_id, { clienteId, estado: 'pendiente', total });
      return { orden_id, total };
    },
    async registrarPago(pago) {
      pagos.push(pago);
      return pagos.length;
    },
    async marcarOrdenPagada(id) { return cambiar(id, 'pagada'); },
    async cancelarOrden(id) { return cambiar(id, 'cancelada'); },
    async expirarOrden(id) { return cambiar(id, 'expirada'); },
    async emitirBoletos(ordenId) {
      const existentes = [...boletos.values()].filter((b) => b.orden_id === ordenId);
      if (existentes.length) return existentes.map(publico);
      const orden = ordenes.get(ordenId);
      for (const [k] of delOrden(orden.sede, ordenId)) {
        const [sede, asiento] = k.split(':').map(Number);
        const codigo_qr = randomUUID().replaceAll('-', '');
        boletos.set(codigo_qr, { boleto_id: ++ultimoBoleto, orden_id: ordenId, sede_id: sede, asiento_id: asiento, codigo_qr, estado: 'emitido' });
      }
      return [...boletos.values()].filter((b) => b.orden_id === ordenId).map(publico);
    },
    async marcarBoletoUsado(qr) {
      const boleto = boletos.get(qr);
      if (!boleto) return { resultado: 'no_existe' };
      if (boleto.estado !== 'emitido') return { resultado: 'no_valido', boleto_id: boleto.boleto_id, estado: boleto.estado };
      boleto.estado = 'usado';
      return { resultado: 'valido', boleto_id: boleto.boleto_id };
    },
  };

  function cambiar(id, nuevo) {
    const orden = ordenes.get(id);
    if (orden.estado === 'pendiente') orden.estado = nuevo;
    return orden.estado === nuevo;
  }
  const publico = ({ boleto_id, sede_id, asiento_id, codigo_qr }) => ({ boleto_id, sede_id, asiento_id, codigo_qr });

  const funcionDe = (f) => ({
    funcion_id: f,
    evento_id: eventoId(f),
    sede_id: sedeDe(f),
    fecha: new Date(Date.UTC(2026, 11, 1 + f, 20)),
    estado: 'abierta',
  });
  const libres = (f) => {
    const sede = sedeDe(f);
    const salida = [];
    for (let pos = 0; pos < 1000; pos++) {
      const id = asientoId(f, pos);
      if (estadoDe(sede, id) !== 'libre') continue;
      salida.push({ asiento_id: id, zona: zonaDe(pos).nombre, precio: zonaDe(pos).precio });
    }
    return salida;
  };

  const postgres = {
    async obtenerFuncion(f) { return f >= 1 && f <= 40 ? funcionDe(f) : null; },
    async listarFunciones(evento) {
      const n = numeroDeEvento(evento);
      if (n < 1 || n > 40) return [];
      return [{ ...funcionDe(n), sede: SEDES[sedeDe(n)], asientos_libres: libres(n).length }].map(({ estado, ...resto }) => resto);
    },
    async asientosLibres(f, sede) {
      if (f < 1 || f > 40 || sedeDe(f) !== sede) return null;
      return libres(f);
    },
    async obtenerAsientos({ sedeId, funcionId, asientos: pedidos }) {
      return pedidos
        .filter((a) => posDeAsiento(funcionId, a) >= 0 && posDeAsiento(funcionId, a) < 1000)
        .map((a) => {
          const z = zonaDe(posDeAsiento(funcionId, a));
          return { asiento_id: a, zona: z.nombre, precio: z.precio, estado: estadoDe(sedeId, a) };
        });
    },
    async reservarAsientos({ sedeId, ordenId, asientos: pedidos }) {
      const ocupados = pedidos.filter((a) => estadoDe(sedeId, a) !== 'libre');
      if (ocupados.length) return { reservado: false, no_disponibles: ocupados };
      for (const a of pedidos) asientos.set(clave(sedeId, a), { estado: 'reservado', ordenId });
      ordenes.get(ordenId).sede = sedeId;
      return { reservado: true, expira_en: new Date(Date.now() + 600000) };
    },
    async confirmarVenta({ sedeId, ordenId }) {
      const suyos = delOrden(sedeId, ordenId);
      if (suyos.length === 0) return false;
      for (const [, v] of suyos) v.estado = 'vendido';
      return true;
    },
    async liberarReserva({ sedeId, ordenId }) {
      const suyos = delOrden(sedeId, ordenId).filter(([, v]) => v.estado === 'reservado');
      for (const [k] of suyos) asientos.delete(k);
      return suyos.length;
    },
  };

  const mongo = {
    async listarEventos({ categoria, limit = 20 } = {}) {
      const lista = [];
      for (let n = 1; n <= 600 && lista.length < limit; n++) {
        const cat = CATEGORIAS[n % CATEGORIAS.length];
        if (categoria && categoria !== cat) continue;
        lista.push({ evento_id: eventoId(n), nombre: `Evento ${n}`, categoria: cat, descripcion: 'Evento de ejemplo' });
      }
      return lista;
    },
    async obtenerEvento(id) {
      const n = numeroDeEvento(id);
      return n >= 1 && n <= 600 ? { evento_id: id, nombre: `Evento ${n}` } : null;
    },
    async registrarActividad(doc) { mongoDocs.actividad.push(doc); },
    async enviarNotificacion(doc) { mongoDocs.notificaciones.push(doc); },
    async crearResena(doc) {
      mongoDocs.resenas.push(doc);
      return randomUUID().replaceAll('-', '').slice(0, 24);
    },
    async registrarAcceso({ codigoQr, puerta }) {
      const acceso = await mysql.marcarBoletoUsado(codigoQr);
      mongoDocs.bitacora.push({ codigoQr, puerta, resultado: acceso.resultado });
      return acceso;
    },
  };

  return { mysql, postgres, mongo, estado: { asientos, ordenes, pagos, boletos, mongoDocs, estadoDe } };
}
