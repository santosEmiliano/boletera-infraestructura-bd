# Monitoreo con Prometheus y Grafana

### Explicación sencilla

Prometheus visita cada pocos segundos una dirección de cada servicio (por ejemplo `pc1:9104/metrics`) y guarda los números que encuentra. Grafana dibuja gráficas con lo que Prometheus guardó. Como MySQL, PostgreSQL y MongoDB no publican métricas en ese formato, a cada uno se le pone un *exporter*.

Prometheus y Grafana corren en PC1. Se ven desde cualquier PC en `http://pc1:9090` y `http://pc1:3000`.

## Qué hay y en qué puerto

| Pieza | Dónde | Puerto | Estado |
|---|---|---|---|
| Prometheus (v3.16.0) | PC1 | 9090 | listo |
| Grafana (13.3.0) | PC1 | 3000 | listo |
| `mysqld_exporter` (v0.21.0) | PC1, PC2, PC3 | 9104 | listo |
| `node_exporter` | PC1 (Mac) y cualquier Linux | 9100 | pendiente de instalar |
| `windows_exporter` | PC3 (Windows) | 9182 | pendiente de instalar |
| `postgres_exporter` (v0.15.0) | PC2 y PC3 | 9187 | listo |
| `mongodb_exporter` (Percona 0.40) | las tres PCs | 9216 (shardA), 9217 (shardB) | listo |
| API | PC1 | 4000 (`/metrics`) | cuando exista la API |

Los exporters del sistema (CPU, RAM, disco) se instalan directo en el sistema operativo, no en Docker. En Mac y Windows, Docker corre dentro de una máquina virtual y un exporter dentro de Docker mediría la máquina virtual, no la PC.

## Levantar

**Exporters de las bases**, en cada PC. El mismo archivo levanta los que tocan a esa PC:

```bash
docker compose -f infra/pcX/exporters.yml up -d
```

| Exporter | PCs | Necesita |
|---|---|---|
| MySQL | las tres | El usuario `exporter` (`mysql/scripts/03_usuarios.sql`) y `EXPORTER_MYSQL_PASSWORD` en el `.env` |
| PostgreSQL | PC2 y PC3 | El rol `exporter` (`postgres/scripts/02_roles.sql`, solo `pg_monitor`) y `EXPORTER_PG_PASSWORD` en el `.env`. Se crea en el primario y llega a la réplica por la replicación, así que la clave es la misma en las dos PCs. Usa `POSTGRES_PORT` para llegar a PostgreSQL |
| MongoDB, uno por shard | las tres | Los shards iniciados. No lleva usuario mientras Mongo no tenga autenticación |

Los de Mongo se conectan **directo** al miembro de esa PC (`--mongodb.direct-connect`), sin seguir al replica set. Si lo siguieran, las tres PCs reportarían al mismo primario; así cada una reporta su propio miembro y se ve cuál es primario y cuál secundario. `--compatible-mode` publica además los nombres de métricas viejos, que son los que usan muchos dashboards publicados.

**Prometheus y Grafana**, solo en PC1:

```bash
docker compose -f infra/pc1/monitoring.yml up -d
```

Cada `.env` sale de su `.env.example`. La clave de Grafana (`GRAFANA_PASSWORD`) es la del usuario `admin`.

## Cómo comprobar que funciona

1. Abrir `http://pc1:9090/targets`. Cada servicio que ya esté levantado debe aparecer en `UP`. Uno caído casi siempre es firewall, un puerto o una contraseña mal.
2. Abrir `http://pc1:3000`. La fuente de datos Prometheus y el dashboard **Boletera - Resumen** (carpeta Boletera) ya vienen cargados desde el repositorio, sin configurar nada a mano.

## Dashboard "Boletera - Resumen"

Está en `infra/monitoring/grafana/dashboards/boletera-resumen.json` y Grafana lo carga solo.

| Panel | Métrica | Verificado |
|---|---|---|
| Servicios activos | `up` | sí |
| Miembros ONLINE del grupo MySQL | `mysql_perf_schema_replication_group_member_info` | sí |
| Miembros del grupo MySQL (rol y estado) | la misma | sí |
| Consultas por segundo (MySQL) | `mysql_global_status_queries` | sí |
| Conexiones abiertas (MySQL) | `mysql_global_status_threads_connected` | sí |
| Peticiones por segundo (API) | `http_peticiones_total` | no, la API aún no existe |
| Compras por resultado | `compras_total` | no, la API aún no existe |
| Latencia p95 y p99 de una compra | `compra_duracion_segundos_bucket` | no, la API aún no existe |

"Verificado" quiere decir que la consulta se corrió contra un exporter real y devolvió datos.

## Métricas de PostgreSQL y MongoDB

Todavía no tienen panel en el dashboard. Estas son las que sirven para ver la replicación y los shards; se comprobaron contra los exporters en la simulación local (`infra/simulacion`):

| Métrica | Exporter | Qué muestra | Valor en la prueba |
|---|---|---|---|
| `pg_up` | PostgreSQL | El exporter llega a la base | 1 en PC2 y en PC3 |
| `pg_replication_is_replica` | PostgreSQL | 0 en el primario, 1 en la réplica. Después de un `pg_promote()` cambia a 0 | 0 en PC2, 1 en PC3 |
| `pg_replication_lag_seconds` | PostgreSQL | Retraso de la réplica | 0 |
| `pg_replication_slots_active{slot_name="replica_pc3"}` | PostgreSQL (primario) | 1 si la réplica está conectada a su slot | 1 |
| `mongodb_up` | MongoDB | El exporter llega al miembro | 1 |
| `mongodb_rs_myState{rs_nm="shardA"}` | MongoDB | Estado del miembro: 1 primario, 2 secundario | 1 en el de PC2 (`shardA`), 2 en el de PC1 (`shardB`) |
| `mongodb_mongod_replset_my_state{set="shardA"}` | MongoDB | Lo mismo con el nombre viejo (`--compatible-mode`) | igual que la anterior |

Con `mongodb_rs_myState` por PC se ve en una sola gráfica dónde está el primario de cada shard y cuándo cambia en una falla. Falta comprobar las métricas en la red real, con Prometheus leyendo los exporters de las tres PCs. Los nombres de las métricas de la API vienen de `docs/api-contrato.md`; si al implementarla cambian, hay que ajustarlos aquí.