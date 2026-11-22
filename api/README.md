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

Las del módulo de PostgreSQL funcionan igual, pero se corren con el usuario `postgres`, porque `boletera_api` no tiene `DELETE` y no podría borrar lo que crean. Usan sus propios datos en la sede 1 (una zona, una función y los asientos 900001 a 900010) y no tocan los del seed. Para correr solo esas:

```bash
PRUEBAS_BD=1 PG_HOST=pc2 PG_USER=postgres PG_PASSWORD=... node --test test/postgres.test.js
```

La prueba de expiración también vence cualquier otra reserva vencida de la base, igual que la API al arrancar.

## Estado

Por ahora los endpoints responden con datos de ejemplo guardados en memoria (`src/stubs/datos.js`), para que el simulador pueda empezar a probar. Todos los datos siguen el contrato, validan la petición, un asiento vendido da 409 y los clientes con número múltiplo de 50 siempre reciben 402. Los datos se pierden al reiniciar.

Ya se tiene:

- `/health` consulta de verdad a las tres bases.
- `/metrics` publica `compras_total`, `compra_duracion_segundos` y `http_peticiones_total`, además de las métricas de Node.
- Las conexiones: un pool de MySQL, un pool de PostgreSQL (20) y el cliente de MongoDB, en `src/db.js`.

El módulo de MySQL (`src/modules/mysql`) lo llamará el orquestador de la compra. Sus funciones son `obtenerCliente`, `crearOrden`, `registrarPago`, `marcarOrdenPagada`, `cancelarOrden`, `expirarOrden`, `emitirBoletos` y `marcarBoletoUsado`.

El módulo de PostgreSQL (`src/modules/postgres`) también lo llamará el orquestador. Todas sus consultas sobre asientos y reservas llevan `sede_id`, para que PostgreSQL solo lea la partición de esa sede.

| Función | Paso de la compra | Qué hace |
|---|---|---|
| `obtenerFuncion` | 1. Validar | La función con su sede y estado, o `null` |
| `listarFunciones` | `GET /api/funciones` | Funciones del evento con la forma del contrato |
| `asientosLibres` | `GET /api/funciones/:id/asientos` | Asientos libres con zona y precio, o `null` si la función no es de esa sede |
| `obtenerAsientos` | 1 y 2. Validar y crear la orden | Zona, precio y estado de los asientos pedidos, para `crearOrden` |
| `reservarAsientos` | 3. Reservar | Todos o ninguno. Devuelve `{ reservado: false, no_disponibles }` para el 409 |
| `confirmarVenta` | 5. Confirmar | Asientos `vendido`. Devuelve `false` si la reserva ya expiró o se canceló |
| `liberarReserva` | Compensación del 402 | Asientos de vuelta a `libre`. En un 409 no hace falta |

`confirmarVenta` y `liberarReserva` se pueden repetir sin duplicar nada.

Al arrancar, la API corre la **expiración** (`src/modules/postgres/expiracion.js`) y la repite cada minuto: libera las reservas que no se pagaron en 10 minutos y marca su orden como `expirada` en MySQL con `expirarOrden`. Si MySQL no responde, reintenta el aviso en la siguiente vuelta.

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
  modules/postgres/  inventario de asientos y expiración de reservas
  stubs/          datos de ejemplo, temporales
test/             pruebas con node:test
```
