# API

Backend en Node/Express (puerto 4000) que conecta MySQL, PostgreSQL y MongoDB. Los endpoints están en `docs/api-contrato.md`.

## Correrla

```bash
cd api
npm install
cp .env.example .env     # y ajustar las claves
npm start
```

`npm test` corre las pruebas de los endpoints y no necesita bases de datos. Las pruebas del modulo de MySQL no se realizan de normal a menos que se pida porque usan la base de datos real y borran lo que crean.

```bash
PRUEBAS_BD=1 MYSQL_HOST=pc1 MYSQL_PASSWORD=... npm test
```

## Estado

Por ahora los endpoints responden con datos de ejemplo guardados en memoria (`src/stubs/datos.js`), para que el simulador pueda empezar a probar. Todos los datos siguen el contrato, validan la petición, un asiento vendido da 409 y los clientes con número múltiplo de 50 siempre reciben 402. Los datos se pierden al reiniciar.

Ya se tiene:

- `/health` consulta de verdad a las tres bases.
- `/metrics` publica `compras_total`, `compra_duracion_segundos` y `http_peticiones_total`, además de las métricas de Node.
- Las conexiones: un pool de MySQL, un pool de PostgreSQL (20) y el cliente de MongoDB, en `src/db.js`.

El módulo de MySQL (`src/modules/mysql`) lo llamará el orquestador de la compra. Sus funciones son `obtenerCliente`, `crearOrden`, `registrarPago`, `marcarOrdenPagada`, `cancelarOrden`, `expirarOrden`, `emitirBoletos` y `marcarBoletoUsado`.

## Estructura

```
src/
  index.js        arranque y cierre ordenado
  app.js          middleware y rutas
  config.js       variables de entorno
  db.js           conexiones a los tres motores
  metricas.js     métricas de Prometheus
  errores.js      errores con código HTTP
  validar.js      validación de las peticiones
  routes/         salud.js (/health, /metrics) y api.js (/api/...)
  modules/mysql/  operaciones sobre MySQL (órdenes, pagos, boletos)
  stubs/          datos de ejemplo, temporales
test/             pruebas con node:test
```
