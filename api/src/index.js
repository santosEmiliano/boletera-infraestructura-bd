import { crearApp } from './app.js';
import { config } from './config.js';
import { mongo, mysqlPool, pgPool } from './db.js';

const servidor = crearApp().listen(config.puerto, () => {
  console.log(`API escuchando en el puerto ${config.puerto}`);
});

async function cerrar() {
  servidor.close();
  await Promise.allSettled([mysqlPool.end(), pgPool.end(), mongo.close()]);
  process.exit(0);
}

process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
