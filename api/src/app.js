import express from 'express';
import { ErrorHttp } from './errores.js';
import { medirPeticiones } from './metricas.js';
import { rutasSalud } from './routes/salud.js';
import api from './routes/api.js';
import { pings as pingsReales } from './db.js';

export function crearApp({ pings = pingsReales } = {}) {
  const app = express();
  app.use(medirPeticiones);
  app.use(express.json());

  app.use(rutasSalud(pings));
  app.use('/api', api);

  app.use((req, res) => res.status(404).json({ error: 'ruta_no_encontrada' }));

  app.use((err, req, res, next) => {
    if (err instanceof ErrorHttp) return res.status(err.status).json(err.cuerpo);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'peticion_invalida', campo: 'cuerpo' });
    console.error(err);
    res.status(500).json({ error: 'error_interno' });
  });

  return app;
}
