# Modelo de las colecciones de MongoDB

Base `boletera`, cinco colecciones fragmentadas entre `shardA` y `shardB` (`docs/mongo-sharding.md`). Este documento fija la forma de cada documento para que el seed y el módulo de Mongo de la API (`api/src/modules/mongo/index.js`) usen los mismos nombres y tipos. Si un campo se escribe distinto (`eventoId` en vez de `evento_id`) o con otro tipo (texto en vez de `ObjectId`), las consultas no encuentran nada y, si es la shard key, `mongos` ya no sabe a qué shard mandarlas.

Los campos que escribe la API son los de su módulo; el seed tiene que usar exactamente esos. Los que solo pone el seed (como `detalle`) se marcan.

## Reglas comunes

- **Nombres** en `snake_case`, igual que en MySQL y PostgreSQL.
- **`evento_id` en MySQL y PostgreSQL** es texto de 24 caracteres: el número del evento en hexadecimal, rellenado con ceros (evento 11 = `"00000000000000000000000b"`). Es la regla de `mysql/seed/README.md`.
- **En Mongo ese mismo valor se guarda como `ObjectId`**: `_id: ObjectId("00000000000000000000000b")` en `eventos`, y `evento_id: ObjectId(...)` en `resenas` y `actividad_usuarios`. La API convierte al leer y al escribir (`new ObjectId(texto)` y `toHexString()`). Si el seed lo guardara como texto, la API no lo encontraría.
- **`cliente_id`** es entero de 1 a 8,000 (los de MySQL). `orden_id` y `boleto_id` también son enteros.
- **Fechas** como `Date` de BSON, no como texto. Así se pueden ordenar y filtrar por rango.

## Cantidades

| Colección | Documentos | De dónde salen |
|---|---|---|
| `eventos` | 600 | Eventos 1 a 600. Los 40 primeros tienen función en PostgreSQL |
| `resenas` | 15,000 | Aleatorias |
| `actividad_usuarios` | ~25,000 | Una `compra` por cada orden pagada de MySQL (~9,600) y el resto aleatorio |
| `bitacora_accesos` | ~3,000 | Un acceso válido por cada boleto `usado` de MySQL (~1,900) y rechazos |
| `notificaciones` | ~12,000 | Una por cada orden pagada, cancelada o expirada de MySQL y recordatorios |
| **Total** | **~55,600** | La rúbrica pide más de 50,000 |

Como el seed de PostgreSQL, el de Mongo lee MySQL (`ordenes` y `boletos`) para que la actividad, los accesos y las notificaciones correspondan a órdenes y boletos que existen. Se corre **después** de `mongo/scripts/04_configurar_sharding.js` y **por `mongos`** (`mongodb://pc2:27017/boletera`); si se insertara antes de fragmentar, todo quedaría en un solo shard.

## `eventos`

La cartelera. Es la colección donde se aprovecha que Mongo no exige un esquema fijo: los campos de `detalle` cambian según la categoría.

```js
{
  _id: ObjectId("00000000000000000000000b"),
  nombre: "Noche de Rock Nacional",
  categoria: "concierto",            // concierto | teatro | deportes | festival
  descripcion: "Tres bandas en vivo...",
  duracion_min: 150,                 // solo seed
  clasificacion: "B",                // solo seed: A | B | B15 | C
  etiquetas: ["rock", "en vivo"],    // solo seed
  detalle: {                         // solo seed
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

La API solo lee `_id`, `nombre`, `categoria` y `descripcion`; el resto es para mostrar la forma variable de Mongo. La categoría del evento `n` es `["concierto", "teatro", "deportes", "festival"][n % 4]`, la misma regla que usaban los stubs de la API, para que el simulador vea la misma cartelera.

Obligatorios: `_id`, `nombre`, `categoria`, `descripcion`, `detalle`, `creado_en`.

| Shard key | Índices extra |
|---|---|
| `{ _id: "hashed" }` | `{ categoria: 1 }` |

- **Shard key:** la compra valida el evento por `_id` y `mongos` va directo a un shard. Son solo 600 documentos, pero se fragmenta igual para que la cartelera también quede repartida y replicada.
- **`{ categoria: 1 }`:** `GET /api/eventos?categoria=` filtra por ella. Esa consulta no lleva `_id`, así que `mongos` la manda a los dos shards y junta las respuestas; con 600 eventos no pesa.

## `resenas`

Lo que guarda `POST /api/resenas`.

```js
{
  _id: ObjectId("..."),
  cliente_id: 4021,
  evento_id: ObjectId("00000000000000000000000b"),
  calificacion: 5,                   // entero de 1 a 5
  comentario: "Muy buen show",       // o null
  creada_en: ISODate("2026-10-02T23:15:00Z")
}
```

Obligatorios: todos; `comentario` puede ser `null`.

| Shard key | Índices extra |
|---|---|
| `{ evento_id: "hashed" }` | ninguno |

- **Shard key:** las reseñas se leen por evento (promedio de calificación, últimas reseñas), y todas las de un evento quedan en el mismo shard. 600 valores distintos alcanzan para repartir.
- **Sin índice extra:** el índice hashed de la shard key ya sirve para buscar por `evento_id` exacto, que es la única consulta prevista.

## `actividad_usuarios`

Lo que hace cada cliente en la app.

La API escribe una `compra` en el paso 6 de cada compra exitosa:

```js
{
  _id: ObjectId("..."),
  cliente_id: 4021,
  tipo: "compra",
  evento_id: ObjectId("00000000000000000000000c"),
  orden_id: 90311,
  fecha: ISODate("2026-11-20T19:42:10Z")
}
```

El seed agrega, además de una `compra` por cada orden `pagada` de MySQL (con la fecha de su pago), actividad de los otros tipos. Esos documentos no llevan `orden_id` y sí un `detalle` que cambia según el tipo:

| Tipo | `detalle` (solo seed) |
|---|---|
| `vio_evento` | `{ origen: "cartelera" | "busqueda" }` |
| `eligio_asientos` | `{ funcion_id, sede_id, asientos: [entero] }` |
| `abandono_carrito` | `{ funcion_id, sede_id, asientos: [entero], total }` |

Obligatorios: `cliente_id`, `tipo`, `evento_id`, `fecha`; `orden_id` en `compra`; `detalle` en los demás.

| Shard key | Índices extra |
|---|---|
| `{ cliente_id: "hashed" }` | `{ cliente_id: 1, fecha: -1 }` |

- **Shard key:** la actividad se consulta por cliente. 8,000 valores distintos.
- **`{ cliente_id: 1, fecha: -1 }`:** el historial de un cliente, del más reciente al más viejo, sale del índice sin ordenar en memoria. Como empieza por la shard key, la consulta va a un solo shard.

## `bitacora_accesos`

Un documento por cada escaneo en la puerta, válido o no (`POST /api/accesos`). El resultado lo decide MySQL al intentar marcar el boleto como `usado`.

```js
{
  _id: ObjectId("..."),
  codigo_qr: "a3f9c1d2e4b5067788990011aabbccdd",
  puerta: "A",
  resultado: "valido",               // valido | no_valido | no_existe
  boleto_id: 55001,                  // null si resultado es no_existe
  fecha: ISODate("2026-12-13T19:05:31Z")
}
```

- `valido`: el boleto estaba `emitido` y quedó `usado`.
- `no_valido`: el boleto existe pero ya estaba `usado` o `anulado`.
- `no_existe`: ningún boleto tiene ese QR.

En el seed: un `valido` por cada boleto `usado` de MySQL; algunos reescaneos de esos mismos boletos y escaneos de boletos `anulado` como `no_valido`; y unos cuantos QR inventados como `no_existe`.

Obligatorios: todos; `boleto_id` es `null` cuando el QR no existe.

| Shard key | Índices extra |
|---|---|
| `{ codigo_qr: "hashed" }` | ninguno |

- **Shard key:** todos los escaneos tienen `codigo_qr`, incluso los de un QR que no existe, y hay un valor distinto por boleto, así que reparte parejo. Los escaneos de un mismo boleto quedan juntos, y mientras un evento está en curso sus escaneos se reparten entre los dos shards.
- **Sin índice extra:** el historial de un boleto se busca por su QR, y el índice hashed de la shard key ya sirve para eso.

## `notificaciones`

La API escribe una `confirmacion` en el paso 6 de cada compra exitosa:

```js
{
  _id: ObjectId("..."),
  cliente_id: 4021,
  tipo: "confirmacion",              // confirmacion | recordatorio | cancelacion | expiracion
  orden_id: 90311,
  mensaje: "Tu compra 90311 está confirmada",
  leida: false,
  creada_en: ISODate("2026-11-20T19:42:11Z")
}
```

En el seed: una `confirmacion` por orden `pagada`, una `cancelacion` por orden `cancelada`, una `expiracion` por orden `expirada` y `recordatorio` para parte de las pagadas. Los otros tipos tienen la misma forma.

Obligatorios: todos.

| Shard key | Índices extra |
|---|---|
| `{ cliente_id: "hashed" }` | `{ cliente_id: 1, creada_en: -1 }` |

- **Shard key:** las notificaciones se leen por cliente, igual que la actividad.
- **`{ cliente_id: 1, creada_en: -1 }`:** la bandeja de un cliente, de la más reciente a la más vieja, desde un solo shard.

## Lo que no se usa a propósito

- **Índices únicos** además de `_id`: en una colección fragmentada solo se puede exigir unicidad si el índice empieza por la shard key, y ninguna regla de la app lo pide (un cliente puede dejar varias reseñas del mismo evento).
- **Validación con `$jsonSchema`:** la forma la cuidan el seed y la API. Se puede agregar después si hace falta mostrarla.
- **Referencias con `$lookup`** entre colecciones: los datos que se leen juntos ya van en el mismo documento, y lo que vive en MySQL o PostgreSQL lo junta la API.
