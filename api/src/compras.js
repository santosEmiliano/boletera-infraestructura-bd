import { randomUUID } from 'node:crypto';
import { ErrorHttp, noEncontrado, peticionInvalida } from './errores.js';

const CODIGOS_TRANSITORIOS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT',
  // Se escribió en un nodo que dejó de ser el primario; ya se buscó el nuevo
  'ER_OPTION_PREVENTS_STATEMENT',
  '40001', '40P01', '57P01',
  // Lo mismo en PostgreSQL: se escribió en la réplica (read-only transaction)
  '25006',
]);
const ERRORES_MONGO = new Set(['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError']);

export function esTransitorio(e) {
  const codigo = String(e?.code ?? '');
  return CODIGOS_TRANSITORIOS.has(codigo)
    || codigo.startsWith('08')
    || ERRORES_MONGO.has(e?.name)
    || /timeout exceeded when trying to connect|Connection terminated/.test(e?.message ?? '');
}

// Repite una operación hasta 3 veces si falla por algo pasajero (conexión caída,
// deadlock). Un error de lógica se propaga a la primera.
export async function conReintentos(operacion, { veces = 3, esperaMs = 100 } = {}) {
  for (let intento = 1; ; intento++) {
    try {
      return await operacion();
    } catch (e) {
      if (intento >= veces || !esTransitorio(e)) throw e;
      await new Promise((resolver) => setTimeout(resolver, esperaMs * intento));
    }
  }
}

// Los clientes con número múltiplo de 50 siempre tienen el pago rechazado
const pagoRechazado = (clienteId) => clienteId % 50 === 0;

export function crearCompras({ mysql, postgres, mongo }, { reintentos } = {}) {
  const intentar = (operacion) => conReintentos(operacion, reintentos);

  // Las compensaciones no deben tapar el error que las provocó: si una falla,
  // se avisa en consola y se sigue con la siguiente.
  async function deshacer(pasos) {
    for (const [nombre, paso] of pasos) {
      try {
        await intentar(paso);
      } catch (e) {
        console.error(`compensación ${nombre}:`, e.message);
      }
    }
  }

  async function comprar(b) {
    const { cliente_id: clienteId, evento_id: eventoId, funcion_id: funcionId, sede_id: sedeId } = b;

    // 1. Validar cliente (MySQL), evento (MongoDB) y función (PostgreSQL)
    const [cliente, evento, funcion] = await Promise.all([
      intentar(() => mysql.obtenerCliente(clienteId, { facturacion: b.factura === true })),
      intentar(() => mongo.obtenerEvento(eventoId)),
      intentar(() => postgres.obtenerFuncion(funcionId)),
    ]);
    if (!cliente) throw noEncontrado('cliente');
    if (!evento) throw noEncontrado('evento');
    if (!funcion || funcion.estado !== 'abierta' || funcion.sede_id !== sedeId || funcion.evento_id !== eventoId) {
      throw noEncontrado('funcion');
    }
    const asientos = await intentar(() => postgres.obtenerAsientos({ sedeId, funcionId, asientos: b.asientos }));
    if (asientos.length !== b.asientos.length) throw peticionInvalida('asientos');

    // 2. Orden pendiente (MySQL)
    const { orden_id: ordenId, total } = await intentar(() =>
      mysql.crearOrden({ clienteId, eventoId, funcionId, sedeId, asientos }));

    const cancelar = ['cancelar la orden', () => mysql.cancelarOrden(ordenId)];
    const liberar = ['liberar los asientos', () => postgres.liberarReserva({ sedeId, ordenId })];

    // 3. Reserva atómica (PostgreSQL). Un error aquí puede haber dejado la
    // reserva a medias, por eso también se libera.
    let reserva;
    try {
      reserva = await intentar(() => postgres.reservarAsientos({ sedeId, funcionId, ordenId, asientos: b.asientos }));
    } catch (e) {
      await deshacer([liberar, cancelar]);
      throw e;
    }
    if (!reserva.reservado) {
      await deshacer([cancelar]);
      throw new ErrorHttp(409, { error: 'asiento_no_disponible', asientos: reserva.no_disponibles });
    }

    // 4. Cobro simulado (MySQL)
    const aprobado = !pagoRechazado(clienteId);
    try {
      await intentar(() => mysql.registrarPago({
        ordenId,
        monto: total,
        metodo: b.metodo_pago,
        estado: aprobado ? 'aprobado' : 'rechazado',
        referencia: `sim-${randomUUID().slice(0, 12)}`,
      }));
    } catch (e) {
      await deshacer([liberar, cancelar]);
      throw e;
    }
    if (!aprobado) {
      await deshacer([liberar, cancelar]);
      throw new ErrorHttp(402, { error: 'pago_rechazado', orden_id: ordenId });
    }

    // 5. Confirmar: asientos vendidos, orden pagada y boletos con QR.
    // Si confirmarVenta falla por un error no se deshace nada: la reserva sigue
    // activa y el proceso de expiración la libera y marca la orden como expirada.
    const vendido = await intentar(() => postgres.confirmarVenta({ sedeId, ordenId }));
    if (!vendido) {
      // La reserva venció mientras se cobraba: no se emiten boletos
      await deshacer([cancelar]);
      throw new ErrorHttp(409, { error: 'asiento_no_disponible', asientos: b.asientos });
    }
    if (!(await intentar(() => mysql.marcarOrdenPagada(ordenId)))) {
      throw new Error(`La orden ${ordenId} no pudo pasar a pagada`);
    }
    const boletos = await intentar(() => mysql.emitirBoletos(ordenId));

    // 6. Actividad y notificación (MongoDB). La compra ya está hecha: si esto
    // falla solo se avisa en consola.
    const avisos = await Promise.allSettled([
      intentar(() => mongo.registrarActividad({ clienteId, tipo: 'compra', eventoId, ordenId })),
      intentar(() => mongo.enviarNotificacion({ clienteId, ordenId, mensaje: `Tu compra ${ordenId} está confirmada` })),
    ]);
    for (const a of avisos) if (a.status === 'rejected') console.error('aviso de la compra:', a.reason.message);

    return { orden_id: ordenId, estado: 'pagada', total, boletos };
  }

  async function escanear({ codigo_qr: codigoQr, puerta }) {
    // Sin reintentos: si el boleto ya se marcó y la respuesta se perdió, repetir
    // el escaneo diría que ya estaba usado
    const acceso = await mongo.registrarAcceso({ codigoQr, puerta });
    if (acceso.resultado === 'no_existe') throw new ErrorHttp(404, { error: 'qr_invalido' });
    if (acceso.resultado === 'no_valido') throw new ErrorHttp(409, { error: 'boleto_no_valido', estado: acceso.estado });
    return { resultado: 'valido', boleto_id: acceso.boleto_id };
  }

  async function dejarResena(b) {
    const [cliente, evento] = await Promise.all([
      intentar(() => mysql.obtenerCliente(b.cliente_id)),
      intentar(() => mongo.obtenerEvento(b.evento_id)),
    ]);
    if (!cliente) throw noEncontrado('cliente');
    if (!evento) throw noEncontrado('evento');
    const id = await intentar(() => mongo.crearResena({
      clienteId: b.cliente_id,
      eventoId: b.evento_id,
      calificacion: b.calificacion,
      comentario: b.comentario,
    }));
    return { resena_id: id };
  }

  return { comprar, escanear, dejarResena };
}
