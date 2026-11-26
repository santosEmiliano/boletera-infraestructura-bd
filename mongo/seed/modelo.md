# Modelo de las colecciones de MongoDB

Base `boletera`, cinco colecciones fragmentadas entre `shardA` y `shardB` (`docs/mongo-sharding.md`). Este documento fija la forma de cada documento para que el seed y el módulo de Mongo de la API usen los mismos nombres y tipos. Si un campo se escribe distinto (`eventoId` en vez de `evento_id`) o con otro tipo (número en vez de texto), las consultas no encuentran nada y, si es la shard key, `mongos` ya no sabe a qué shard mandarlas.

## Reglas comunes

- **Nombres** en `snake_case`, igual que en MySQL y PostgreSQL.
- **`evento_id`** es texto de 24 caracteres: el número del evento en hexadecimal, rellenado con ceros (evento 11 = `"00000000000000000000000b"`). Es la misma regla de `mysql/seed/README.md`.
- **`_id` de `eventos`** es ese mismo texto, no un `ObjectId`. MySQL (`ordenes.evento_id`) y PostgreSQL (`funciones.evento_id`) lo guardan como `VARCHAR(24)` y la API lo recibe como texto; si en Mongo fuera `ObjectId`, cada consulta tendría que convertirlo, y una consulta con el tipo equivocado devuelve vacío sin error. En las demás colecciones `_id` es el `ObjectId` que pone Mongo.
- **`cliente_id`** es entero de 1 a 8,000 (los de MySQL). `funcion_id`, `sede_id`, `asiento_id`, `orden_id` y `boleto_id` también son enteros, con los rangos de `docs/api-contrato.md`.
- **Fechas** como `Date` de BSON, no como texto. Así se pueden ordenar y filtrar por rango.
- **Montos** como número (`1700`), no como texto.

## Cantidades

| Colección | Documentos | De dónde salen |
|---|---|---|
| `eventos` | 600 | Eventos 1 a 600. Los 40 primeros tienen función en PostgreSQL |
| `resenas` | 15,000 | Aleatorias |
| `actividad_usuarios` | ~25,000 | Un `compro` por cada orden pagada de MySQL (~9,600) y el resto aleatorio |
| `bitacora_accesos` | ~3,000 | Un acceso válido por cada boleto `usado` de MySQL (~1,900) y rechazos |
| `notificaciones` | ~12,000 | Una por cada orden pagada, cancelada o expirada de MySQL y recordatorios |
| **Total** | **~55,600** | La rúbrica pide más de 50,000 |

Como el seed de PostgreSQL, el de Mongo lee MySQL (`ordenes`, `orden_detalle` y `boletos`) para que la actividad, los accesos y las notificaciones correspondan a órdenes y boletos que existen. Se corre **después** de `mongo/scripts/04_configurar_sharding.js` y **por `mongos`** (`mongodb://pc2:27017/boletera`); si se insertara antes de fragmentar, todo quedaría en un solo shard.

## `eventos`

La cartelera. Es la colección donde se aprovecha que Mongo no exige un esquema fijo: los campos de `detalle` cambian según la categoría.

```js
{
  _id: "00000000000000000000000b",
  nombre: "Noche de Rock Nacional",
  categoria: "concierto",            // concierto | teatro | deportes | festival
  descripcion: "Tres bandas en vivo...",
  duracion_min: 150,
  clasificacion: "B",                // A | B | B15 | C
  etiquetas: ["rock", "en vivo"],
  detalle: {
    artistas: ["Banda Uno", "Banda Dos", "Banda Tres"],
    genero: "rock"
  },
  creado_en: ISODate("2026-09-14T18:00:00Z")
}
```

`detalle` según `categoria`:

| Categoría | `detalle` |
|---|---|
| `concierto` | `{ artistas: [texto], genero: texto }` |
| `teatro` | `{ compania: texto, director: texto, elenco: [texto] }` |
| `deportes` | `{ liga: texto, local: texto, visitante: texto }` |
| `festival` | `{ dias: entero, escenarios: [{ nombre: texto, artistas: [texto] }] }` |

La categoría del evento `n` es `["concierto", "teatro", "deportes", "festival"][n % 4]`, la misma que usan los stubs de la API (`api/src/stubs/datos.js`), para que el simulador vea la misma cartelera con stubs y con la base real.

Obligatorios: `_id`, `nombre`, `categoria`, `descripcion`, `detalle`, `creado_en`.

| Shard key | Índices extra |
|---|---|
| `{ _id: "hashed" }` | `{ categoria: 1 }` |

- **Shard key:** la compra valida el evento por `_id` y `mongos` va directo a un shard. Son solo 600 documentos, pero se fragmenta igual para que la cartelera también quede repartida y replicada.
- **`{ categoria: 1 }`:** `GET /api/eventos?categoria=` filtra por ella. Esa consulta no lleva `_id`, así que `mongos` la manda a los dos shards y junta las respuestas; con 600 eventos no pesa.

## `resenas`

```js
{
  _id: ObjectId("..."),
  evento_id: "00000000000000000000000b",
  cliente_id: 4021,
  calificacion: 5,                   // entero de 1 a 5
  comentario: "Muy buen show",
  creado_en: ISODate("2026-10-02T23:15:00Z")
}
```

Obligatorios: todos. Es lo que guarda `POST /api/resenas`, más `creado_en`.

| Shard key | Índices extra |
|---|---|
| `{ evento_id: "hashed" }` | ninguno |

- **Shard key:** las reseñas se leen por evento (promedio de calificación, últimas reseñas), y todas las de un evento quedan en el mismo shard. 600 valores distintos alcanzan para repartir.
- **Sin índice extra:** el índice hashed de la shard key ya sirve para buscar por `evento_id` exacto, que es la única consulta prevista.

## `actividad_usuarios`

Lo que hace cada cliente en la app. Como en `eventos`, `detalle` cambia según `tipo`.

```js
{
  _id: ObjectId("..."),
  cliente_id: 4021,
  tipo: "compro",                    // vio_evento | eligio_asientos | abandono_carrito | compro
  evento_id: "00000000000000000000000c",
  fecha: ISODate("2026-11-20T19:42:10Z"),
  detalle: {
    orden_id: 90311,
    funcion_id: 12,
    sede_id: 2,
    asientos: [15, 16],
    total: 1700,
    metodo_pago: "tarjeta"
  }
}
```

`detalle` según `tipo`:

| Tipo | `detalle` |
|---|---|
| `vio_evento` | `{ origen: "cartelera" | "busqueda" }` |
| `eligio_asientos` | `{ funcion_id, sede_id, asientos: [entero] }` |
| `abandono_carrito` | `{ funcion_id, sede_id, asientos: [entero], total }` |
| `compro` | `{ orden_id, funcion_id, sede_id, asientos: [entero], total, metodo_pago }` |

El documento `compro` lo escribe la API en el paso 6 de la compra, con los datos de la orden recién pagada. En el seed sale uno por cada orden `pagada` de MySQL, con la fecha de su pago.

Obligatorios: `cliente_id`, `tipo`, `evento_id`, `fecha`, `detalle`.

| Shard key | Índices extra |
|---|---|
| `{ cliente_id: "hashed" }` | `{ cliente_id: 1, fecha: -1 }` |

- **Shard key:** la actividad se consulta por cliente. 8,000 valores distintos.
- **`{ cliente_id: 1, fecha: -1 }`:** el historial de un cliente, del más reciente al más viejo, sale del índice sin ordenar en memoria. Como empieza por la shard key, la consulta va a un solo shard.

## `bitacora_accesos`

Un documento por cada escaneo en la puerta, válido o no (`POST /api/accesos`).

```js
{
  _id: ObjectId("..."),
  codigo_qr: "a3f9c1d2e4b5067788990011aabbccdd",
  resultado: "valido",               // valido | qr_invalido | boleto_no_valido
  boleto_id: 55001,
  evento_id: "00000000000000000000000c",
  funcion_id: 12,
  sede_id: 2,
  puerta: "A",
  estado_boleto: "emitido",          // el estado que tenía el boleto al escanearlo
  fecha: ISODate("2026-12-13T19:05:31Z")
}
```

Si el QR no existe (`qr_invalido`), no hay boleto: el documento lleva solo `codigo_qr`, `resultado`, `puerta` y `fecha`, sin `boleto_id`, `evento_id`, `funcion_id`, `sede_id` ni `estado_boleto`. Mongo acepta documentos sin la shard key y los trata como si valiera `null`; todos esos rechazos quedan en el mismo trozo, y como son pocos no importa.

En el seed: un `valido` por cada boleto `usado` de MySQL, con `estado_boleto: "emitido"`; algunos reescaneos de esos mismos boletos como `boleto_no_valido` con `estado_boleto: "usado"`; escaneos de boletos `anulado`; y unos cuantos QR inventados como `qr_invalido`. El `evento_id`, la función y la sede salen de la orden del boleto.

Obligatorios: `codigo_qr`, `resultado`, `puerta`, `fecha`; los demás solo cuando el QR existe.

| Shard key | Índices extra |
|---|---|
| `{ evento_id: "hashed" }` | `{ boleto_id: 1 }` |

- **Shard key:** los accesos se cuentan por evento (cuánta gente entró). Mientras un evento está en curso, todos sus escaneos caen en el mismo shard; se acepta porque son pocos por segundo y el otro shard atiende los demás eventos.
- **`{ boleto_id: 1 }`:** el historial de escaneos de un boleto. No lleva la shard key, así que va a los dos shards.

## `notificaciones`

```js
{
  _id: ObjectId("..."),
  cliente_id: 4021,
  tipo: "confirmacion",              // confirmacion | recordatorio | cancelacion | expiracion
  canal: "email",                    // email | push
  orden_id: 90311,
  evento_id: "00000000000000000000000c",
  titulo: "Tu compra está confirmada",
  mensaje: "Orden 90311: 2 boletos para el 13 de diciembre.",
  enviada_en: ISODate("2026-11-20T19:42:11Z"),
  leida: false
}
```

La `confirmacion` la escribe la API en el paso 6 de la compra. En el seed: una `confirmacion` por orden `pagada`, una `cancelacion` por orden `cancelada`, una `expiracion` por orden `expirada` y `recordatorio` para parte de las pagadas.

Obligatorios: todos.

| Shard key | Índices extra |
|---|---|
| `{ cliente_id: "hashed" }` | `{ cliente_id: 1, enviada_en: -1 }` |

- **Shard key:** las notificaciones se leen por cliente, igual que la actividad.
- **`{ cliente_id: 1, enviada_en: -1 }`:** la bandeja de un cliente, de la más reciente a la más vieja, desde un solo shard.

## Lo que no se usa a propósito

- **Índices únicos** además de `_id`: en una colección fragmentada solo se puede exigir unicidad si el índice empieza por la shard key, y ninguna regla de la app lo pide (un cliente puede dejar varias reseñas del mismo evento).
- **Validación con `$jsonSchema`:** la forma la cuidan el seed y la API. Se puede agregar después si hace falta mostrarla.
- **Referencias con `$lookup`** entre colecciones: los datos que se leen juntos ya van en el mismo documento (`detalle`), y lo que vive en MySQL o PostgreSQL lo junta la API.
