#!/usr/bin/env bash
# Permite que la réplica (PC3) se conecte para replicar.
# Corre una sola vez, en el primer arranque, después de 01_schema.sql.
#
# La regla "host all all all" que trae la imagen no cubre las conexiones de
# replicación: la palabra "replication" en pg_hba.conf se tiene que nombrar
# aparte. Se acepta cualquier origen porque con Docker Desktop la IP de la otra
# PC suele llegar como una dirección interna del motor de Docker; se compensa con
# el firewall, la red local y la contraseña del rol replicator (decisión 14).
set -e

echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
