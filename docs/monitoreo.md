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
| `postgres_exporter` | PC2 y PC3 | 9187 | cuando exista PostgreSQL |
| `mongodb_exporter` | las tres PCs | 9216 (shardA), 9217 (shardB) | cuando existan los shards |
| API | PC1 | 4000 (`/metrics`) | cuando exista la API |

Los exporters del sistema (CPU, RAM, disco) se instalan directo en el sistema operativo, no en Docker. En Mac y Windows, Docker corre dentro de una máquina virtual y un exporter dentro de Docker mediría la máquina virtual, no la PC.

## Levantar

**Exporter de MySQL**, en cada PC. Necesita que el usuario `exporter` exista (lo crea `mysql/scripts/03_usuarios.sql`) y su clave en el `.env`:

```bash
docker compose -f infra/pcX/exporters.yml up -d
```

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

"Verificado" quiere decir que la consulta se corrió contra un exporter real y devolvió datos. Los nombres de las métricas de la API vienen de `docs/api-contrato.md`; si al implementarla cambian, hay que ajustarlos aquí.