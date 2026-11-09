# Contrato de la API

La API (Node/Express, puerto 4000) es lo único que habla con las tres bases de datos. El simulador y cualquier cliente usan solo estos endpoints.

Todo utiliza formato JSON. Los errores siempre tienen la forma `{ "error": "codigo", ... }`.

## Resumen

| Método | Ruta | Motores | Para qué |
|---|---|---|---|
| GET | `/health` | los tres | Saber si la API ve las bases |
| GET | `/api/eventos` | MongoDB | Cartelera |
| GET | `/api/funciones?evento_id=` | PostgreSQL | Funciones de un evento |
| GET | `/api/funciones/:id/asientos?sede_id=` | PostgreSQL | Asientos libres |
| POST | `/api/compras` | los tres | Comprar boletos |
| POST | `/api/accesos` | MySQL y MongoDB | Escanear un boleto en la puerta |
| POST | `/api/resenas` | MongoDB | Dejar una reseña |
| GET | `/metrics` | | Métricas para Prometheus |

## GET /health

```json
{ "mysql": "ok", "postgres": "ok", "mongo": "ok" }
```

Si una base no responde, su valor es `"error"` y el código HTTP es 503.

## GET /api/eventos

Parámetros opcionales: `categoria`, `limit` (por defecto 20).

```json
[
  {
    "evento_id": "66f1a2b3c4d5e6f708192a3b",
    "nombre": "Festival Primavera",
    "categoria": "concierto",
    "descripcion": "..."
  }
]
```

`evento_id` es el `_id` del documento en MongoDB, como texto de 24 caracteres.

## GET /api/funciones

Parámetro obligatorio: `evento_id`.

```json
[
  {
    "funcion_id": 12,
    "evento_id": "66f1a2b3c4d5e6f708192a3b",
    "sede_id": 2,
    "sede": "Guadalajara",
    "fecha": "2026-12-05T20:00:00Z",
    "asientos_libres": 640
  }
]
```

## GET /api/funciones/:id/asientos

Parámetro obligatorio: `sede_id`. Se pide siempre porque PostgreSQL reparte los asientos por sede y así solo revisa la partición que toca.

```json
[
  { "asiento_id": 15, "zona": "General", "precio": 850.00 },
  { "asiento_id": 16, "zona": "General", "precio": 850.00 }
]
```

Solo devuelve los asientos con estado `libre`.

## POST /api/compras

Ejecuta el proceso completo de compra.

Cuerpo:

```json
{
  "cliente_id": 4021,
  "evento_id": "66f1a2b3c4d5e6f708192a3b",
  "funcion_id": 12,
  "sede_id": 2,
  "asientos": [15, 16],
  "metodo_pago": "tarjeta",
  "factura": false
}
```

`metodo_pago` puede ser `tarjeta`, `transferencia` o `efectivo`. `factura` es opcional; si es `true`, se leen los datos fiscales del cliente.

Respuestas:

| Código | Cuándo | Cuerpo |
|---|---|---|
| 201 | Compra completa | ver abajo |
| 400 | Falta un campo o tiene formato inválido | `{ "error": "peticion_invalida", "campo": "asientos" }` |
| 404 | No existe el cliente, el evento o la función | `{ "error": "no_encontrado", "recurso": "cliente" }` |
| 409 | Algún asiento ya no está libre | `{ "error": "asiento_no_disponible", "asientos": [16] }` |
| 402 | El pago fue rechazado | `{ "error": "pago_rechazado", "orden_id": 90311 }` |
| 500 | Falla interna | `{ "error": "error_interno" }` |

Éxito (201):

```json
{
  "orden_id": 90311,
  "estado": "pagada",
  "total": 1700.00,
  "boletos": [
    { "boleto_id": 55001, "sede_id": 2, "asiento_id": 15, "codigo_qr": "a3f9c1d2e4b5067788990011aabbccdd" },
    { "boleto_id": 55002, "sede_id": 2, "asiento_id": 16, "codigo_qr": "0f1e2d3c4b5a69788796a5b4c3d2e1f0" }
  ]
}
```

Reglas que cumple siempre:

- Un asiento nunca se vende dos veces. Si dos compras piden el mismo asiento a la vez, una recibe 201 y la otra 409.
- En un 409 o un 402 no queda nada retenido: los asientos vuelven a `libre` y la orden queda `cancelada`.
- Los asientos reservados que no se pagan en 10 minutos se liberan solos y la orden queda `expirada`.

### Pasos internos

1. Valida cliente (MySQL), evento (MongoDB) y función (PostgreSQL).
2. Crea la orden en estado `pendiente` (MySQL).
3. Reserva los asientos con una sola sentencia atómica (PostgreSQL). Si no consigue todos, cancela la orden y responde 409.
4. Cobra de forma simulada y guarda el pago (MySQL). Si lo rechazan, libera los asientos, cancela la orden y responde 402.
5. Confirma la venta: asientos `vendido` (PostgreSQL), orden `pagada` y boletos con QR (MySQL).
6. Registra la actividad y la notificación de confirmación (MongoDB).

No hay transacción entre motores. Si un paso falla después de otro, se deshace con una operación contraria (compensación).

## POST /api/accesos

Escaneo del boleto en la puerta.

```json
{ "codigo_qr": "a3f9c1d2e4b5067788990011aabbccdd", "puerta": "A" }
```

| Código | Cuándo | Cuerpo |
|---|---|---|
| 200 | Boleto válido, queda como `usado` | `{ "resultado": "valido", "boleto_id": 55001 }` |
| 404 | El QR no existe | `{ "error": "qr_invalido" }` |
| 409 | El boleto ya se usó o está anulado | `{ "error": "boleto_no_valido", "estado": "usado" }` |

Cada intento, válido o no, se guarda en `bitacora_accesos` (MongoDB).

## POST /api/resenas

```json
{
  "cliente_id": 4021,
  "evento_id": "66f1a2b3c4d5e6f708192a3b",
  "calificacion": 5,
  "comentario": "Muy buen show"
}
```

`calificacion` es un entero de 1 a 5. Responde 201 con `{ "resena_id": "..." }`, o 400 / 404 con el mismo formato de errores de arriba.

## GET /metrics

Formato de texto de Prometheus. Métricas propias:

- `compras_total{resultado}`: contador con los valores `exitosa`, `asiento_no_disponible`, `pago_rechazado` y `error`.
- `compra_duracion_segundos`: histograma con la duración de cada compra.
- `http_peticiones_total{ruta,codigo}`: contador de peticiones.

Además, las métricas por defecto del proceso de Node (memoria, CPU, event loop).

## Datos de prueba

Para que el simulador y los seeds coincidan:

| Dato | Rango |
|---|---|
| `cliente_id` | 1 a 8,000 |
| `evento_id` | 600 eventos en MongoDB |
| `sede_id` | 1 a 4 |
| `funcion_id` | 1 a 40 (10 por sede) |
| `asiento_id` | 1 a 10,000 dentro de cada sede |
