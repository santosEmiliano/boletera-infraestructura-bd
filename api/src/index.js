import { crearApp } from './app.js';
import { config } from './config.js';
import { mongo, mysqlPool, pgPool } from './db.js';
import { expirarHuerfanas, expirarOrden } from './modules/mysql/index.js';
import { iniciarExpiracion } from './modules/postgres/expiracion.js';

// Una orden pendiente con más de esto ya no está en curso (la reserva dura 10)
const MINUTOS_HUERFANA = 15;

const servidor = crearApp().listen(config.puerto, () => {
  console.log(`API escuchando en el puerto ${config.puerto}`);
});

// Libera cada minuto las reservas no pagadas y marca su orden 'expirada' en MySQL,
// y también las órdenes pendientes que quedaron huérfanas
const expiracion = iniciarExpiracion({
  alExpirar: expirarOrden,
  limpiarHuerfanas: () => expirarHuerfanas(MINUTOS_HUERFANA),
});

async function cerrar() {
  expiracion.detener();
  servidor.close();
  await Promise.allSettled([mysqlPool.end(), pgPool.end(), mongo.close()]);
  process.exit(0);
}

process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
