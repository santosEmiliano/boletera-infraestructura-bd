# Seed de MongoDB

Carga las cinco colecciones de la base `boletera`, unas 55,600 filas, con la forma que fija `modelo.md`.

## Uso

Va **por `mongos`** y **después** de `mongo/scripts/04_configurar_sharding.js` y `06_indices.js`: si se cargara antes de fragmentar, todo quedaría en un solo shard. También lee MySQL (`ordenes`, `pagos` y `boletos`), así que va después del seed de MySQL.

```bash
cd mongo/seed
npm install
MONGO_URI=mongodb://pc2:27017/boletera MYSQL_HOST=pc1 MYSQL_PASSWORD=clave node seed.js
```

En Windows, con `$env:MONGO_URI = "..."`, `$env:MYSQL_HOST = "pc1"` y `$env:MYSQL_PASSWORD = "..."` antes de `node seed.js`.

Variables: `MONGO_URI` (por defecto `mongodb://localhost:27017/boletera`), y para MySQL las mismas del seed de MySQL: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER` (`root`), `MYSQL_PASSWORD` (obligatoria) y `MYSQL_DATABASE`.

- Si `MONGO_URI` no apunta a un `mongos`, se detiene. Para probarlo contra un MongoDB suelto: `--sin-mongos`.
- Si la base ya tiene datos, se detiene. Con `--reiniciar` borra los documentos y vuelve a cargar. Borra con `deleteMany` y no tira las colecciones, para que conserven su fragmentación y sus índices.

## Qué genera

| Colección | Documentos | De dónde salen |
|---|---|---|
| `eventos` | 600 | Eventos 1 a 600, con `_id` igual al número en hexadecimal (el acuerdo de `mysql/seed/README.md`) y `detalle` distinto según la categoría |
| `resenas` | 15,000 | Al azar; el 60 % de los eventos con función (1 a 40) |
| `actividad_usuarios` | 25,000 | Una `compra` por cada orden pagada de MySQL, con la fecha de su pago, y el resto `vio_evento`, `eligio_asientos` y `abandono_carrito` |
| `bitacora_accesos` | 3,000 | Un `valido` por cada boleto `usado`, `no_valido` por los `anulado` y por reescaneos, y QR inventados como `no_existe` |
| `notificaciones` | 12,000 | `confirmacion`, `cancelacion` o `expiracion` según el estado de cada orden, y `recordatorio` para parte de las pagadas |

Con el seed de MySQL de siempre, las compras, notificaciones y accesos coinciden con las órdenes y los boletos de MySQL (mismo cliente, mismo evento, mismo boleto). Los asientos de `eligio_asientos` y `abandono_carrito` son de la función que dicen y su `total` sale de los precios por zona.
