import client from 'prom-client';

export const registro = new client.Registry();
client.collectDefaultMetrics({ register: registro });

const peticiones = new client.Counter({
  name: 'http_peticiones_total',
  help: 'Peticiones HTTP recibidas',
  labelNames: ['ruta', 'codigo'],
  registers: [registro],
});

export const compras = new client.Counter({
  name: 'compras_total',
  help: 'Compras según su resultado',
  labelNames: ['resultado'],
  registers: [registro],
});

export const duracionCompra = new client.Histogram({
  name: 'compra_duracion_segundos',
  help: 'Duración de una compra completa',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registro],
});

// Para que las series existan desde el inicio, aunque todavía no haya compras
for (const r of ['exitosa', 'asiento_no_disponible', 'pago_rechazado', 'error']) compras.inc({ resultado: r }, 0);

export function medirPeticiones(req, res, next) {
  res.on('finish', () => {
    const ruta = req.route ? req.baseUrl + req.route.path : 'no_encontrada';
    peticiones.inc({ ruta, codigo: res.statusCode });
  });
  next();
}
