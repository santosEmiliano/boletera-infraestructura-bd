import { Router } from 'express';
import { ErrorHttp, peticionInvalida } from '../errores.js';
import { compras, duracionCompra } from '../metricas.js';
import { enteroDeConsulta, validarAcceso, validarCompra, validarResena } from '../validar.js';
import * as datos from '../stubs/datos.js';

const router = Router();

router.get('/eventos', (req, res) => {
  const limit = req.query.limit === undefined ? 20 : enteroDeConsulta(req.query.limit, 'limit');
  res.json(datos.listarEventos(req.query.categoria, Math.min(limit, 100)));
});

router.get('/funciones', (req, res) => {
  const evento = req.query.evento_id;
  if (typeof evento !== 'string' || !/^[0-9a-f]{24}$/.test(evento)) throw peticionInvalida('evento_id');
  res.json(datos.listarFunciones(evento));
});

router.get('/funciones/:id/asientos', (req, res) => {
  const funcion = enteroDeConsulta(req.params.id, 'funcion_id');
  const sede = enteroDeConsulta(req.query.sede_id, 'sede_id');
  res.json(datos.asientosLibres(funcion, sede));
});

router.post('/compras', (req, res) => {
  validarCompra(req.body);
  const fin = duracionCompra.startTimer();
  let resultado = 'error';
  try {
    const orden = datos.comprar(req.body);
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

router.post('/accesos', (req, res) => {
  validarAcceso(req.body);
  res.json(datos.escanear(req.body.codigo_qr));
});

router.post('/resenas', (req, res) => {
  validarResena(req.body);
  res.status(201).json(datos.crearResena(req.body));
});

export default router;
