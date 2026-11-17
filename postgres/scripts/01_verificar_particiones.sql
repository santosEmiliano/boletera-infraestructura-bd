-- Evidencia de la fragmentación horizontal de PostgreSQL.
-- Solo lee, no modifica nada, así que también se puede correr en la réplica
-- de PC3 para comprobar que las particiones y sus datos se replicaron.
--
-- Uso (dentro del contenedor, con la carpeta postgres montada en /postgres):
--   psql -U postgres -d boletera -f /postgres/scripts/01_verificar_particiones.sql

\echo '== 1. Particiones de cada tabla y la sede que guarda cada una =='
SELECT i.inhparent::regclass                   AS tabla,
       i.inhrelid::regclass                    AS particion,
       pg_get_expr(c.relpartbound, c.oid)      AS valores
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent IN ('asientos'::regclass, 'reservas_asiento'::regclass)
ORDER BY 1, 2;

\echo '== 2. Filas por partición: asientos =='
SELECT tableoid::regclass AS particion, count(*) AS filas
FROM asientos
GROUP BY 1
ORDER BY 1;

\echo '== 3. Filas por partición: reservas_asiento =='
SELECT tableoid::regclass AS particion, count(*) AS filas
FROM reservas_asiento
GROUP BY 1
ORDER BY 1;

\echo '== 4. Con sede_id: solo se lee la partición de esa sede (asientos_cdmx) =='
EXPLAIN (COSTS OFF)
SELECT * FROM asientos WHERE sede_id = 2;

\echo '== 5. Sin sede_id: se leen las 4 particiones (Append) =='
EXPLAIN (COSTS OFF)
SELECT * FROM asientos WHERE funcion_id = 1;

\echo '== 6. Lo mismo en reservas_asiento: solo reservas_cdmx =='
EXPLAIN (COSTS OFF)
SELECT * FROM reservas_asiento WHERE sede_id = 2;
