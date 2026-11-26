# Inventario

Las IPs son de ejemplo hasta confirmarlas. Las versiones son las de las imágenes que usan los compose de `infra/`.

## Equipos

| PC | Sistema | IP | RAM | Docker |
|---|---|---|---|---|
| PC1 | macOS (ARM) | 192.168.1.101 | | |
| PC2 | _por confirmar_ | 192.168.1.102 | | |
| PC3 | Windows 11 | 192.168.1.103 | | |

## Servicios

Estado:

- **probado en simulación**: el compose existe y se ensayó en una sola máquina, con varios contenedores haciendo de PCs (`infra/simulacion` o contenedores de prueba).
- **probado en local**: el compose o el programa existe y se probó en una sola PC.
- **pendiente**: todavía no existe o no se ha instalado.

Nada se ha levantado todavía en la red real entre las tres PCs.

| Servicio | PC | Puerto | Versión | Contenedor | Volumen | Rol | Estado |
|---|---|---|---|---|---|---|---|
| MySQL | PC1 | 3306, 33061 | 8.0 | mysql-pc1 | boletera_mysql_data | Miembro del grupo | probado en simulación |
| MySQL | PC2 | 3306, 33061 | 8.0 | mysql-pc2 | boletera_mysql_data | Miembro del grupo | probado en simulación |
| MySQL | PC3 | 3306, 33061 | 8.0 | mysql-pc3 | boletera_mysql_data | Miembro del grupo | probado en simulación |
| PostgreSQL | PC2 | 5432 (`POSTGRES_PORT`) | 16 | postgres-pc2 | boletera_pgdata | Primario | probado en simulación |
| PostgreSQL | PC3 | 5432 (`POSTGRES_PORT`) | 16 | postgres-pc3 | boletera_pgdata | Réplica (streaming) | probado en simulación |
| Mongo config server | PC1, PC2, PC3 | 27019 | 7.0 | mongo-cfg-pcX | boletera_mongo_cfg | Miembro de cfgRS | probado en simulación |
| Mongo shardA | PC1, PC2, PC3 | 27018 | 7.0 | mongo-shard-a-pcX | boletera_mongo_shard_a | Miembro de shardA | probado en simulación |
| Mongo shardB | PC1, PC2, PC3 | 27020 | 7.0 | mongo-shard-b-pcX | boletera_mongo_shard_b | Miembro de shardB | probado en simulación |
| mongos | PC2 | 27017 | 7.0 | mongos-pc2 | | Enrutador | probado en simulación |
| `mysqld_exporter` | PC1, PC2, PC3 | 9104 | v0.21.0 | mysqld-exporter-pcX | | Métricas de MySQL | probado en local |
| `postgres_exporter` | PC2, PC3 | 9187 | v0.15.0 | postgres-exporter-pcX | | Métricas de PostgreSQL | probado en simulación |
| `mongodb_exporter` shardA | PC1, PC2, PC3 | 9216 | 0.40 (Percona) | mongodb-exporter-shard-a-pcX | | Métricas del miembro de shardA | probado en simulación |
| `mongodb_exporter` shardB | PC1, PC2, PC3 | 9217 | 0.40 (Percona) | mongodb-exporter-shard-b-pcX | | Métricas del miembro de shardB | probado en simulación |
| `node_exporter` | PC1 (y cualquier Linux) | 9100 | | sin contenedor | | Métricas del sistema | pendiente |
| `windows_exporter` | PC3 | 9182 | | sin contenedor | | Métricas del sistema | pendiente |
| Prometheus | PC1 | 9090 | v3.16.0 | prometheus | boletera_prometheus_data | Monitoreo | probado en local |
| Grafana | PC1 | 3000 | 13.3.0 | grafana | boletera_grafana_data | Monitoreo | probado en local |
| API Express | PC1 | 4000 | Node.js | sin contenedor (`npm start`) | | Backend | probado en local |

`X` es el número de la PC (`mongo-cfg-pc1`, `mongo-cfg-pc2`...). Cada PC tiene sus propios volúmenes aunque se llamen igual: el nombre es local a cada máquina.

Los exporters del sistema van fuera de Docker: en Mac y Windows, Docker corre en una máquina virtual y un exporter en contenedor mediría la máquina virtual (`docs/monitoreo.md`).

## Dónde está cada cosa

| Servicio | Compose | Guía |
|---|---|---|
| MySQL | `infra/pcX/mysql.yml` | `docs/replicacion-mysql.md` |
| PostgreSQL | `infra/pc2/postgres.yml`, `infra/pc3/postgres.yml` | `postgres/README.md`, `docs/replicacion-postgres.md` |
| MongoDB (cfgRS, shards, mongos) | `infra/pcX/mongo.yml` | `docs/mongo-config-servers.md`, `docs/mongo-sharding.md` |
| Exporters | `infra/pcX/exporters.yml` | `docs/monitoreo.md` |
| Prometheus y Grafana | `infra/pc1/monitoring.yml` | `docs/monitoreo.md` |
| API | `api/` | `api/README.md`, `docs/api-contrato.md` |
| Simulación en una sola máquina | `infra/simulacion/postgres.yml`, `infra/simulacion/mongo.yml` | `docs/replicacion-postgres.md`, `docs/mongo-sharding.md` |
| Qué hacer si algo falla | | `docs/procedimientos-falla.md` |
