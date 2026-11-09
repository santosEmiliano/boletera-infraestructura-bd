# Inventario

Las IPs son de ejemplo hasta confirmarlas. Las versiones de imagen son sugeridas.

## Equipos

| PC | Sistema | IP | RAM | Docker |
|---|---|---|---|---|
| PC1 | macOS (ARM) | 192.168.1.101 | | |
| PC2 | _por confirmar_ | 192.168.1.102 | | |
| PC3 | Windows 11 | 192.168.1.103 | | |

## Servicios

| Servicio | PC | Puerto | Versión | Contenedor | Volumen | Rol | Estado |
|---|---|---|---|---|---|---|---|
| MySQL | PC1 | 3306, 33061 | 8.0 | mysql-pc1 | boletera_mysql_data | Miembro del grupo | planeado |
| MySQL | PC2 | 3306, 33061 | 8.0 | mysql-pc2 | boletera_mysql_data | Miembro del grupo | planeado |
| MySQL | PC3 | 3306, 33061 | 8.0 | mysql-pc3 | boletera_mysql_data | Miembro del grupo | planeado |
| PostgreSQL | PC2 | 5432 | 16 | postgres-pc2 | boletera_pgdata | Primario | planeado |
| PostgreSQL | PC3 | 5432 | 16 | postgres-pc3 | boletera_pgdata | Réplica | planeado |
| Mongo config server | PC1, PC2, PC3 | 27019 | 7.0 | mongo-cfg-pcX | boletera_mongo_cfg | Miembro de cfgRS | planeado |
| Mongo shardA | PC1, PC2, PC3 | 27018 | 7.0 | mongo-shard-a-pcX | boletera_mongo_shard_a | Miembro de shardA | planeado |
| Mongo shardB | PC1, PC2, PC3 | 27020 | 7.0 | mongo-shard-b-pcX | boletera_mongo_shard_b | Miembro de shardB | planeado |
| mongos | PC2 | 27017 | 7.0 | mongos-pc2 | | Enrutador | planeado |
| Prometheus | PC1 | 9090 | | | | Monitoreo | planeado |
| Grafana | PC1 | 3000 | | | | Monitoreo | planeado |
| API Express | PC1 | 4000 | Node.js | | | Backend | planeado |
