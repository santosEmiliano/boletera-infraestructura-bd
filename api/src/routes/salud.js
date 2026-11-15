import { Router } from 'express';
import { registro } from '../metricas.js';

const conTiempo = (promesa, ms) =>
  Promise.race([promesa, new Promise((_, rechazo) => setTimeout(() => rechazo(new Error('tiempo agotado')), ms))]);

export function rutasSalud(pings) {
  const router = Router();

  router.get('/health', async (req, res) => {
    const nombres = Object.keys(pings);
    const resultados = await Promise.all(
      nombres.map((n) => conTiempo(pings[n](), 3000).then(() => 'ok', () => 'error')),
    );
    const estado = Object.fromEntries(nombres.map((n, i) => [n, resultados[i]]));
    res.status(resultados.every((r) => r === 'ok') ? 200 : 503).json(estado);
  });

  router.get('/metrics', async (req, res) => {
    res.type(registro.contentType).send(await registro.metrics());
  });

  return router;
}
