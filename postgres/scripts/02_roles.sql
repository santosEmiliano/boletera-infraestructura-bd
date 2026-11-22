-- Roles de PostgreSQL para la API y para Prometheus.
-- Se corre en el primario; la réplica los recibe sola porque la replicación
-- física copia todo el servidor, roles incluidos.
-- Las contraseñas llegan como variables de psql y nunca se guardan en el repo:
--   psql -U postgres -d boletera -v ON_ERROR_STOP=1 \
--        -v api_clave=... -v exporter_clave=... -f 02_roles.sql
-- Se puede volver a correr: crea los roles si no existen y actualiza sus contraseñas.

-- PostgreSQL no tiene CREATE ROLE IF NOT EXISTS: se arma el CREATE solo si el
-- rol no existe y \gexec lo ejecuta.
SELECT 'CREATE ROLE boletera_api'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'boletera_api') \gexec
SELECT 'CREATE ROLE exporter'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'exporter') \gexec

-- ---------------------------------------------------------------------------
-- boletera_api: lo mínimo que necesita la API, sin superusuario.
-- ---------------------------------------------------------------------------
ALTER ROLE boletera_api WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'api_clave';

GRANT CONNECT ON DATABASE :"DBNAME" TO boletera_api;
GRANT USAGE ON SCHEMA public TO boletera_api;

-- Lee todo: catálogo, asientos, reservas y movimientos.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO boletera_api;

-- Reservar, confirmar, liberar y expirar solo cambian asientos y reservas.
GRANT INSERT, UPDATE ON asientos, reservas_asiento TO boletera_api;

-- La bitácora solo crece: la API puede agregar movimientos, no cambiarlos ni borrarlos.
GRANT INSERT ON movimientos_inventario TO boletera_api;

-- Los BIGSERIAL de reservas y movimientos necesitan la secuencia.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO boletera_api;

-- ---------------------------------------------------------------------------
-- exporter: métricas para postgres_exporter (puerto 9187), sin leer datos.
-- ---------------------------------------------------------------------------
ALTER ROLE exporter WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 3 PASSWORD :'exporter_clave';

-- pg_monitor es el rol predefinido para leer las vistas de estadísticas
-- (pg_stat_activity, pg_stat_replication, ...).
GRANT pg_monitor TO exporter;
