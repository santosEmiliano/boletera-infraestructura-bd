# PostgreSQL

Inventario de asientos de la boletera. Corre en PC2 como primario. La réplica en PC3 llega con la replicación.

| Carpeta | Qué tiene |
|---|---|
| `init/` | Esquema (`01_schema.sql`). El contenedor lo corre solo en el primer arranque |
| `scripts/` | Verificación de particiones y roles. En el contenedor se montan en `/scripts` |
| `seed/` | Datos de prueba que se leen de MySQL. Ver `seed/README.md` |

El diseño (tablas, partición por sede, zonas y usuarios) está en `docs/arquitectura.md`, sección 3.

## Levantar en PC2

Los comandos se corren desde la raíz del repo.

1. Crear el `.env` a partir del ejemplo y cambiar las claves y las IPs:

   ```bash
   cp infra/pc2/.env.example infra/pc2/.env
   ```

   En PowerShell: `Copy-Item infra/pc2/.env.example infra/pc2/.env`.

2. Levantar el contenedor:

   ```bash
   docker compose -f infra/pc2/postgres.yml up -d
   ```

3. Esperar a que la columna `STATUS` diga `(healthy)`:

   ```bash
   docker compose -f infra/pc2/postgres.yml ps
   ```

4. Comprobar que se creó el esquema. Deben aparecer las 6 tablas y las 8 particiones:

   ```bash
   docker exec postgres-pc2 psql -U postgres -d boletera -c "\dt"
   ```

5. Crear los roles `boletera_api` y `exporter`, con las claves de `API_PG_PASSWORD` y `EXPORTER_PG_PASSWORD` del `.env`:

   ```bash
   docker exec postgres-pc2 psql -U postgres -d boletera -v ON_ERROR_STOP=1 -v api_clave=... -v exporter_clave=... -f /scripts/02_roles.sql
   ```

6. Cargar los datos de prueba con el seed (`seed/README.md`), contra `PGHOST=localhost` y el puerto de `POSTGRES_PORT`. Antes tiene que estar cargado el seed de MySQL.

7. Verificar las particiones y la poda:

   ```bash
   docker exec postgres-pc2 psql -U postgres -d boletera -f /scripts/01_verificar_particiones.sql
   ```

## Apagar sin perder datos

```bash
docker compose -f infra/pc2/postgres.yml down
```

Los datos se quedan en el volumen `boletera_pgdata` y vuelven con el siguiente `up -d`. El esquema no se vuelve a correr.

`down -v` borra también el volumen: se pierden el esquema, los roles y los datos. Solo hace falta para empezar de cero, por ejemplo después de cambiar `init/01_schema.sql`.

## Cosas a tener en cuenta

- **`init/` y `POSTGRES_PASSWORD` solo se aplican con el volumen vacío.** Si después cambias la clave en el `.env`, `postgres` sigue con la anterior. Para cambiarla, usa `ALTER ROLE postgres PASSWORD '...'` o empieza de cero con `down -v`.
- **Puerto ocupado.** Si la máquina ya tiene otro PostgreSQL en 5432, pon otro puerto en `POSTGRES_PORT` (por ejemplo, 5433). Dentro del contenedor sigue siendo 5432. En la PC2 real se deja en 5432, que es el que esperan la API, la réplica y Prometheus.
- **Las claves solo se piden desde fuera.** Dentro del contenedor las conexiones locales entran sin contraseña (`trust`). Para comprobar una clave hay que conectarse desde fuera, por ejemplo:

  ```bash
  docker run --rm -e PGPASSWORD=... postgres:16 psql -h host.docker.internal -p 5432 -U boletera_api -d boletera -c "SELECT 1"
  ```
