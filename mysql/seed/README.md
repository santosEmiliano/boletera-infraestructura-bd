# Seed de MySQL

Carga datos de prueba en la base `boletera`: unas 74,000 filas repartidas en las seis tablas.

## Uso

```bash
cd mysql/seed
npm install
MYSQL_PASSWORD=clave MYSQL_HOST=pc1 node seed.js
```

Variables: `MYSQL_HOST` (por defecto `localhost`), `MYSQL_PORT` (3306), `MYSQL_USER` (`root`), `MYSQL_PASSWORD` (obligatoria) y `MYSQL_DATABASE` (`boletera`).

Si la base ya tiene datos, el script se detiene. Con `--reiniciar` vacía las tablas y vuelve a cargar. Los datos son los mismos en cada corrida.

Cuando el grupo de replicación esté formado, hay que correrlo contra el nodo primario.

## Qué genera

| Tabla | Filas aprox. |
|---|---|
| `clientes_contacto` y `clientes_facturacion` | 8,000 cada una |
| `ordenes` | 12,000 (80 % pagadas, 10 % canceladas, 5 % expiradas, 5 % pendientes) |
| `orden_detalle` | ~19,700 |
| `pagos` | ~10,800 (aprobados en las pagadas, rechazados en las canceladas) |
| `boletos` | ~15,700 (uno por asiento de cada orden pagada) |

## Acuerdos con los seeds de PostgreSQL y MongoDB

Las referencias entre motores solo funcionan si los tres seeds usan estas reglas:

- **Función `f` (1 a 40):** está en la sede `ceil(f / 10)` y corresponde al evento número `f`.
- **Asientos:** la función `f` usa los 1,000 asientos que empiezan en `((f - 1) % 10) * 1000 + 1` dentro de su sede. Por ejemplo, la función 1 usa del 1 al 1000 de la sede 1, y la función 12 usa del 1001 al 2000 de la sede 2.
- **`evento_id`:** es el número del evento escrito en hexadecimal y rellenado con ceros hasta 24 caracteres (evento 11 = `00000000000000000000000b`). El seed de MongoDB debe insertar los eventos con ese `_id`.
- **Zonas por función**, según la posición del asiento: VIP (primeros 100, $1,800), Preferente (hasta el 350, $1,200), General (hasta el 700, $850) y Balcón (el resto, $500).

Ningún asiento se repite en las órdenes, ni siquiera entre las canceladas.
