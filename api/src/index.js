import { crearApp } from './app.js';
import { config } from './config.js';
import { mongo, mysqlPool, pgPool } from './db.js';
import { expirarOrden } from './modules/mysql/index.js';
import { iniciarExpiracion } from './modules/postgres/expiracion.js';

const servidor = crearApp().listen(config.puerto, () => {
  console.log(`API escuchando en el puerto ${config.puerto}`);
});

// Libera cada minuto las reservas no pagadas y marca su orden 'expirada' en MySQL
const expiracion = iniciarExpiracion({ alExpirar: expirarOrden });

async function cerrar() {
  expiracion.detener();
  servidor.close();
  await Promise.allSettled([mysqlPool.end(), pgPool.end(), mongo.close()]);
  process.exit(0);
}

process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
