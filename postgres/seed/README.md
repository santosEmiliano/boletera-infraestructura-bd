# Seed de PostgreSQL

Carga los datos de prueba en la base `boletera`: unas 98,000 filas. Las reservas y los movimientos salen de las órdenes que ya existen en MySQL, así que los dos motores quedan con los mismos asientos vendidos, reservados y libres.

## Requisitos

1. El esquema de PostgreSQL ya cargado (`postgres/init/01_schema.sql`).
2. **MySQL con sus datos.** Primero se corre el seed de MySQL (`mysql/seed`) y después este.

## Uso

```bash
cd postgres/seed
npm install
PGPASSWORD=clave PGHOST=pc2 MYSQL_PASSWORD=clave MYSQL_HOST=pc1 node seed.js
```

En PowerShell, las variables se ponen antes, una por línea (`$env:PGPASSWORD = "clave"`), y luego se corre `node seed.js`.

| Variable | Por defecto | |
|---|---|---|
| `PGHOST` | `localhost` | |
| `PGPORT` | `5432` | |
| `PGUSER` | `postgres` | |
| `PGPASSWORD` | | obligatoria |
| `PGDATABASE` | `boletera` | |
| `MYSQL_HOST` | `localhost` | En Windows conviene `127.0.0.1` |
| `MYSQL_PORT` | `3306` | |
| `MYSQL_USER` | `root` | |
| `MYSQL_PASSWORD` | | obligatoria |
| `MYSQL_DATABASE` | `boletera` | |

Si la base ya tiene datos, el script se detiene. Con `--reiniciar` vacía las tablas y vuelve a cargar. Todo va en una sola transacción: si algo falla, no queda nada a medias y, con `--reiniciar`, los datos anteriores vuelven.

Se corre contra el **primario**. La réplica recibe los datos por la replicación.

## Qué genera

| Tabla | Filas |
|---|---|
| `zonas` | 40 (10 por sede, en bloques de 100 asientos) |
| `funciones` | 40 (10 por sede), en los próximos 6 meses |
| `asientos` | 40,000 (1,000 por función, 10,000 por partición) |
| `reservas_asiento` | una por cada asiento en una orden de MySQL (19,675 con el seed actual) |
| `movimientos_inventario` | `reserva` más su cierre por cada asiento en una orden (38,330 con el seed actual) |

`sedes` (4 filas) la carga el esquema, no el seed.

Con la misma base de MySQL, los datos son los mismos en cada corrida. Lo único que cambia son las fechas de las funciones, que se calculan a partir del día en que se corre.

## Cómo se traduce cada orden de MySQL

| Orden en MySQL | Asiento | Reserva | Movimientos |
|---|---|---|---|
| `pagada` | `vendido` | `confirmada` | `reserva` y `venta` |
| `cancelada` (pago rechazado) | `libre` | `cancelada` | `reserva` y `liberacion` |
| `expirada` | `libre` | `expirada` | `reserva` y `liberacion` |
| `pendiente` | `reservado` | `activa` | `reserva` |

Las fechas salen de MySQL: la reserva se crea con la orden y vence 10 minutos después; la venta o la liberación ocurren al pagar o al rechazar el pago, y en una orden expirada, cuando vence la reserva.

Las órdenes `pendiente` tienen fechas pasadas, así que sus reservas ya vencieron. El proceso de expiración de la API las libera en cuanto arranca.

## Acuerdos con el seed de MySQL

Los mismos de `mysql/seed/README.md`: la función `f` está en la sede `ceil(f / 10)`, corresponde al evento `f` (`evento_id` en hexadecimal de 24 caracteres) y usa los asientos `((f - 1) % 10) * 1000 + 1` a `+ 1000` de su sede.

## Comprobar que coinciden

En MySQL, asientos por estado de la orden:

```sql
SELECT o.estado, COUNT(*) FROM orden_detalle d JOIN ordenes o ON o.orden_id = d.orden_id GROUP BY o.estado;
```

En PostgreSQL, reservas y asientos por estado:

```sql
SELECT estado, count(*) FROM reservas_asiento GROUP BY 1;
SELECT estado, count(*) FROM asientos GROUP BY 1;
```

`pagada` debe ser igual a `confirmada` y a `vendido`, y también al número de filas de `boletos` en MySQL. `pendiente` debe ser igual a `activa` y a `reservado`.
