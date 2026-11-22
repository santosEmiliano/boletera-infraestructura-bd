-- Rol y slot para la Streaming Replication PC2 -> PC3.
-- Se corre en el primario, antes del pg_basebackup de la réplica:
--   psql -U postgres -d boletera -v ON_ERROR_STOP=1 \
--        -v replicator_clave=... -f 03_replicacion.sql
-- Se puede volver a correr: crea el rol y el slot si no existen y actualiza la
-- contraseña.

-- ---------------------------------------------------------------------------
-- replicator: solo puede replicar. No lee tablas ni tiene permisos en la base;
-- la regla de pg_hba.conf (init/02_pg_hba_replicacion.sh) solo lo deja entrar
-- a conexiones de replicación.
-- ---------------------------------------------------------------------------
SELECT 'CREATE ROLE replicator'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replicator') \gexec

ALTER ROLE replicator WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE
    PASSWORD :'replicator_clave';

-- ---------------------------------------------------------------------------
-- Slot físico de PC3: el primario guarda el WAL que la réplica aún no recibe,
-- así que si PC3 se cae un rato, al volver se pone al día sin tener que copiar
-- todo otra vez.
-- Cuidado: mientras PC3 esté abajo el WAL se acumula en PC2. Si la réplica se
-- da de baja para siempre, borrar el slot:
--   SELECT pg_drop_replication_slot('replica_pc3');
-- ---------------------------------------------------------------------------
SELECT pg_create_physical_replication_slot('replica_pc3')
WHERE NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = 'replica_pc3');

SELECT slot_name, slot_type, active FROM pg_replication_slots;
