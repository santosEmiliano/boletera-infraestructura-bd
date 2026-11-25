import { Router } from 'express';
import { ErrorHttp, noEncontrado, peticionInvalida } from '../errores.js';
import { compras, duracionCompra } from '../metricas.js';
import { crearCompras } from '../compras.js';
import { enteroDeConsulta, validarAcceso, validarCompra, validarResena } from '../validar.js';

export function crearRutasApi(servicios) {
  const router = Router();
  const { mongo, postgres } = servicios;
  const orquestador = crearCompras(servicios);

  router.get('/eventos', async (req, res) => {
    const limit = req.query.limit === undefined ? 20 : enteroDeConsulta(req.query.limit, 'limit');
    const categoria = typeof req.query.categoria === 'string' ? req.query.categoria : undefined;
    res.json(await mongo.listarEventos({ categoria, limit: Math.min(limit, 100) }));
  });

  router.get('/funciones', async (req, res) => {
    const evento = req.query.evento_id;
    if (typeof evento !== 'string' || !/^[0-9a-f]{24}$/.test(evento)) throw peticionInvalida('evento_id');
    res.json(await postgres.listarFunciones(evento));
  });

  router.get('/funciones/:id/asientos', async (req, res) => {
    const funcion = enteroDeConsulta(req.params.id, 'funcion_id');
    const sede = enteroDeConsulta(req.query.sede_id, 'sede_id');
    const asientos = await postgres.asientosLibres(funcion, sede);
    if (!asientos) throw noEncontrado('funcion');
    res.json(asientos);
  });

  router.post('/compras', async (req, res) => {
    validarCompra(req.body);
    const fin = duracionCompra.startTimer();
    let resultado = 'error';
    try {
      const orden = await orquestador.comprar(req.body);
      resultado = 'exitosa';
      res.status(201).json(orden);
    } catch (e) {
      if (e instanceof ErrorHttp && (e.status === 409 || e.status === 402)) resultado = e.cuerpo.error;
      else if (e instanceof ErrorHttp) resultado = null;
      throw e;
    } finally {
      fin();
      if (resultado) compras.inc({ resultado });
    }
  });

  router.post('/accesos', async (req, res) => {
    validarAcceso(req.body);
    res.json(await orquestador.escanear(req.body));
  });

  router.post('/resenas', async (req, res) => {
    validarResena(req.body);
    res.status(201).json(await orquestador.dejarResena(req.body));
  });

  return router;
}
