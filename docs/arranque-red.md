# Arranque en la red real

El orden para levantar todo en las tres PCs, de una red vacía a la API vendiendo. Cada fase termina con una comprobación: **no se pasa a la siguiente hasta que la anterior salga bien**, porque casi todo depende de lo de antes (el seed de PostgreSQL lee MySQL, la réplica copia el primario, `mongos` necesita los config servers...).

El detalle de cada servicio está en su guía; aquí va el orden y lo mínimo para no perderse:

| Servicio | Guía |
|---|---|
| MySQL | `docs/replicacion-mysql.md`, `mysql/seed/README.md` |
| PostgreSQL | `postgres/README.md`, `postgres/seed/README.md`, `docs/replicacion-postgres.md` |
| MongoDB | `docs/mongo-config-servers.md`, `docs/mongo-sharding.md` |
| Monitoreo | `docs/monitoreo.md` |
| API y simulador | `api/README.md`, `simulator/README.md` |
| Si algo falla | `docs/procedimientos-falla.md` |

Los comandos se corren **desde la raíz del repo**. Los de `docker` son iguales en Windows y Mac. Cuando cambian (variables de entorno, rutas), van las dos versiones.

## Papeles

Llenar antes de empezar:

| PC | Máquina | Sistema | IP | Corre |
|---|---|---|---|---|
| PC1 | | | | MySQL, Mongo (cfg, shardA, shardB), mongos (segundo), Prometheus, Grafana, API |
| PC2 | | | | MySQL, **PostgreSQL primario**, Mongo (cfg, shardA, shardB), **mongos** |
| PC3 | | | | MySQL, **PostgreSQL réplica**, Mongo (cfg, shardA, shardB) |

Las tres llevan sus exporters. El simulador puede correr en cualquier PC con Node.

## Fase 0. Antes de juntarse (cada quien en su máquina)

1. Repo al día en `main`: `git checkout main` y `git pull`.
2. Docker Desktop con **al menos 6 GB de RAM** asignados (Ajustes > Resources). Cada PC corre MySQL, tres `mongod` y, en PC2 y PC3, PostgreSQL.
3. Node 20 o más reciente en la PC de la API (PC1) y en la que corra los seeds.
4. Bajar las imágenes con buena conexión, para no depender de la red del día. En cada PC, por cada compose que le toca:

   ```bash
   docker compose -f infra/pcX/mysql.yml pull
   docker compose -f infra/pcX/mongo.yml pull
   docker compose -f infra/pcX/exporters.yml pull
   ```

   Más `infra/pc2/postgres.yml` o `infra/pc3/postgres.yml` en PC2 y PC3, e `infra/pc1/monitoring.yml` en PC1.

5. Que la máquina no se duerma durante la prueba: en Windows, Configuración > Sistema > Energía > "Nunca"; en Mac, `caffeinate -dims` en una terminal aparte.
6. En la máquina que sea PC2: si tiene otro PostgreSQL en el 5432 (por ejemplo un contenedor de otro proyecto), detenerlo con `docker stop <contenedor>`. En la red real PC2 usa el 5432: lo esperan la réplica, la API y Prometheus.

## Fase 1. Red

**1. IP fija en cada PC.** Si la IP cambia a media prueba, nada se encuentra. Lo más seguro es una reserva DHCP en el router (la PC siempre recibe la misma). Si no hay acceso al router, a mano, con la IP que la PC ya tiene:

- **Windows:** Configuración > Red e Internet > Ethernet (o Wi-Fi) > Asignación de IP > Editar > Manual. IPv4 con la IP actual, máscara `255.255.255.0`, la puerta de enlace y el DNS del router (los da `ipconfig`).
- **Mac:** Ajustes del Sistema > Red > (la conexión) > Detalles > TCP/IP > Configurar IPv4: Manualmente, con los mismos datos (los da `ipconfig getifaddr en0` y el router).

**2. Nombres y firewall.** Con las tres IPs ya decididas, en cada PC. Primero sin cambiar nada, para revisar:

- **Windows** (PowerShell como administrador):

  ```powershell
  powershell -ExecutionPolicy Bypass -File infra\red\preparar-red-windows.ps1 -Pc X -Pc1Ip IP1 -Pc2Ip IP2 -Pc3Ip IP3 -SoloMostrar
  ```

- **Mac:**

  ```bash
  bash infra/red/preparar-red-mac.sh --pc X --pc1 IP1 --pc2 IP2 --pc3 IP3 --solo-mostrar
  ```

Si dice que la IP de esa PC no es la suya, volver al paso 1. Si todo cuadra, el mismo comando **sin** `-SoloMostrar` / `--solo-mostrar` lo aplica: agrega `pc1`, `pc2` y `pc3` al archivo hosts y abre los puertos (Windows) o permite a Docker (Mac).

**3. Red Privada (Windows).** Si el script avisa que la red es Pública, cambiarla con el comando que muestra (`Set-NetConnectionProfile ... -NetworkCategory Private`). En Pública, Windows bloquea todo aunque los puertos estén abiertos.

**Comprobar:** desde cada PC, las otras dos responden por nombre:

```bash
ping pc1
ping pc2
ping pc3
```

Si el `ping` falla entre PCs que sí tienen internet, la red aísla a los equipos entre sí (típico en el Wi-Fi de una escuela). Opciones: un router propio, el hotspot de un celular, o Tailscale (ver "Si algo no conecta").

## Fase 2. Archivos `.env`

En cada PC, `infra/pcX/.env` a partir de `infra/pcX/.env.example` (`cp` en Mac, `Copy-Item` en PowerShell).

| Variable | Dónde | Regla |
|---|---|---|
| `PC1_IP`, `PC2_IP`, `PC3_IP` | las tres | **Iguales en las tres**, las de la tabla de papeles |
| `MYSQL_ROOT_PASSWORD` | las tres | La misma en las tres (más fácil) |
| `EXPORTER_MYSQL_PASSWORD` | las tres | La misma: es un solo usuario que se replica |
| `POSTGRES_PASSWORD`, `API_PG_PASSWORD` | PC2 | Las del primario |
| `POSTGRES_PORT` | PC2 y PC3 | `5432` |
| `REPLICATOR_PASSWORD` | PC2 y PC3 | **La misma en las dos** |
| `EXPORTER_PG_PASSWORD` | PC2 y PC3 | **La misma en las dos**: el rol llega a la réplica con la replicación |
| `GRAFANA_PASSWORD` | PC1 | La del usuario `admin` de Grafana |

## Fase 3. MySQL (las tres PCs)

Detalle en `docs/replicacion-mysql.md`, "Formar el grupo".

1. En cada PC: `docker compose -f infra/pcX/mysql.yml up -d` y esperar `healthy` con `docker compose -f infra/pcX/mysql.yml ps`.
2. En cada PC, el usuario de recuperación (`01_recuperacion.sql`, misma clave en las tres).
3. Solo en PC1: `02_arrancar_grupo.sql`.
4. En PC2 y después en PC3: `START GROUP_REPLICATION;`.
5. En el primario: `03_usuarios.sql` (claves de `boletera_api`, `contacto_ro` y `exporter`; la de `exporter` es `EXPORTER_MYSQL_PASSWORD`).

**Comprobar:** `source /scripts/04_estado.sql` en cualquier nodo: `pc1` `PRIMARY` y `pc2`, `pc3` `SECONDARY`, los tres `ONLINE`. Si uno se queda en `RECOVERING`, revisar el puerto 33061.

## Fase 4. Datos de MySQL

Desde una PC con Node, contra el primario. Detalle en `mysql/seed/README.md`.

- **Mac:**

  ```bash
  cd mysql/seed
  npm install
  MYSQL_PASSWORD=... MYSQL_HOST=pc1 node seed.js
  ```

- **Windows:**

  ```powershell
  cd mysql\seed
  npm install
  $env:MYSQL_PASSWORD = "..."
  $env:MYSQL_HOST = "pc1"
  node seed.js
  ```

**Comprobar:** `SELECT COUNT(*) FROM ordenes;` da lo mismo en los tres nodos (unas 12,000).

## Fase 5. PostgreSQL (PC2 y luego PC3)

Detalle en `postgres/README.md` y `docs/replicacion-postgres.md`. El orden importa: roles y datos **antes** de copiar a la réplica, para que lleguen con la copia.

**En PC2:**

1. `docker compose -f infra/pc2/postgres.yml up -d` y esperar `healthy`.
2. Roles de la API y del exporter (`API_PG_PASSWORD` y `EXPORTER_PG_PASSWORD`):

   ```bash
   docker exec postgres-pc2 psql -U postgres -d boletera -v ON_ERROR_STOP=1 -v api_clave=... -v exporter_clave=... -f /scripts/02_roles.sql
   ```

3. Datos (lee MySQL, así que va después de la fase 4). Desde PC2, con Node:

   - **Mac:** `cd postgres/seed`, `npm install` y `PGPASSWORD=... PGHOST=localhost MYSQL_PASSWORD=... MYSQL_HOST=pc1 node seed.js`
   - **Windows:** `cd postgres\seed`, `npm install`, `$env:PGPASSWORD = "..."`, `$env:PGHOST = "localhost"`, `$env:MYSQL_PASSWORD = "..."`, `$env:MYSQL_HOST = "pc1"` y `node seed.js`

4. Rol `replicator` y slot (`REPLICATOR_PASSWORD`):

   ```bash
   docker exec postgres-pc2 psql -U postgres -d boletera -v ON_ERROR_STOP=1 -v replicator_clave=... -f /scripts/03_replicacion.sql
   ```

**En PC3:**

5. Si hay un volumen de una prueba anterior: `docker compose -f infra/pc3/postgres.yml down -v`.
6. Copiar el primario. **No escribir nada hasta el 100 % y el prompt**:

   ```bash
   docker compose -f infra/pc3/postgres.yml run --rm --no-deps --user postgres -e PGPASSWORD=... postgres pg_basebackup -h pc2 -U replicator -D /var/lib/postgresql/data -Fp -Xs -P -R -S replica_pc3
   ```

7. `docker compose -f infra/pc3/postgres.yml up -d`.

**Comprobar:**

```bash
docker exec postgres-pc2 psql -U postgres -c "SELECT client_addr, state FROM pg_stat_replication;"
```

En PC2, una fila en `streaming`.

```bash
docker exec postgres-pc3 psql -U postgres -c "SELECT pg_is_in_recovery();"
```

En PC3, `t`. Y `01_verificar_particiones.sql` en PC3 da los mismos conteos que en PC2.

## Fase 6. MongoDB (las tres PCs)

Detalle en `docs/mongo-config-servers.md` y `docs/mongo-sharding.md`.

1. En cada PC: `docker compose -f infra/pcX/mongo.yml up -d` y esperar `healthy` en `mongo-cfg`, `mongo-shard-a` y `mongo-shard-b`.
2. Desde PC1, los config servers:

   ```bash
   docker exec -it mongo-cfg-pc1 mongosh --port 27019 --file /scripts/01_iniciar_config.js
   ```

3. Desde PC2, los dos shards:

   ```bash
   docker exec -it mongo-shard-a-pc2 mongosh --port 27018 --file /scripts/03_iniciar_shard.js
   docker exec -it mongo-shard-b-pc2 mongosh --port 27020 --file /scripts/03_iniciar_shard.js
   ```

4. Esperar a que `mongos-pc2` (en PC2) y `mongos-pc1` (en PC1) digan `healthy` (`docker compose -f infra/pcX/mongo.yml ps`). Antes de eso, todavía no se conectan a los config servers y responden `ECONNREFUSED`.
5. En PC2, sharding e índices:

   ```bash
   docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/04_configurar_sharding.js
   docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/06_indices.js
   ```

6. Datos de Mongo **por `mongos`** (`mongodb://pc2:27017/boletera`), siguiendo `mongo/seed/modelo.md`. _Pendiente: el seed todavía no existe._

**Comprobar:**

```bash
docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/05_estado_sharding.js
```

Cada shard con un `PRIMARY` y dos `SECONDARY`, las 5 colecciones fragmentadas y, con datos, repartidos entre `shardA` y `shardB`.

## Fase 7. Exporters y monitoreo

Detalle en `docs/monitoreo.md`.

1. En cada PC: `docker compose -f infra/pcX/exporters.yml up -d`.
2. En cada PC, el exporter del sistema: `windows_exporter` en Windows, `node_exporter` en Mac. Si el sistema de alguna PC no es el que dice `infra/monitoring/prometheus.yml` (hoy: PC1 Mac, PC2 y PC3 Windows), mover su línea antes del paso 3.
3. En PC1: `docker compose -f infra/pc1/monitoring.yml up -d`.

**Comprobar:** `http://pc1:9090/targets`, todo en `UP`. En `http://pc1:3000`, el dashboard **Boletera - Resumen**.

## Fase 8. API y simulador

En PC1, `api/.env` a partir de `api/.env.example`:

| Variable | Valor |
|---|---|
| `MYSQL_HOSTS` | `pc1,pc2,pc3` |
| `MYSQL_PASSWORD` | La de `boletera_api` en MySQL (fase 3) |
| `PG_HOSTS` | `pc2,pc3` |
| `PG_PASSWORD` | `API_PG_PASSWORD` (fase 5) |
| `MONGO_URI` | `mongodb://pc2:27017,pc1:27017/boletera` (los dos `mongos`) |

```bash
cd api
npm install
npm start
```

**Comprobar:** `http://pc1:4000/health` responde `{"mysql":"ok","postgres":"ok","mongo":"ok"}`. Después, desde cualquier PC con Node:

```bash
cd simulator
node run.js --url http://pc1:4000
```

Las 50 compras salen con 201 (o 402 las de clientes múltiplos de 50) y `Doble venta` en 0.

## Lista final

| Qué | Dónde se ve | Esperado |
|---|---|---|
| Red | `ping pcX` desde cada PC | Las tres responden |
| MySQL | `04_estado.sql` | 1 `PRIMARY` y 2 `SECONDARY`, todos `ONLINE` |
| PostgreSQL | `pg_stat_replication` en PC2, `pg_is_in_recovery()` en PC3 | `streaming` y `t` |
| MongoDB | `05_estado_sharding.js` | Cada shard con primario; 5 colecciones fragmentadas; `mongos-pc1` y `mongos-pc2` en `healthy` |
| Monitoreo | `http://pc1:9090/targets` | Todo `UP` |
| API | `http://pc1:4000/health` | Los tres `ok` |
| Compras | simulador, perfil decenas | Sin errores 500 y `Doble venta` 0 |

Con esto arriba se siguen las pruebas de carga y de fallas (`docs/procedimientos-falla.md`).

## Si algo no conecta

| Síntoma | Causa probable | Qué revisar |
|---|---|---|
| `ping pcX` no responde, pero hay internet | La red aísla a los equipos | Router propio, hotspot o Tailscale (abajo) |
| `ping` responde pero un servicio no | Firewall o red Pública | `Test-NetConnection pcX -Port N` (Windows) o `nc -vz pcX N` (Mac); volver a correr el script de red; red en Privada |
| Un contenedor no encuentra `pcX` | IPs mal en el `.env` | `PCX_IP` iguales en las tres PCs; `docker compose ... config` muestra los valores |
| MySQL se queda en `RECOVERING` | Puerto 33061 cerrado | Firewall de esa PC |
| `pg_basebackup` no conecta | Clave de `replicator` o puerto 5432 | `REPLICATOR_PASSWORD` igual en PC2 y PC3; el 5432 libre en PC2 |
| La API: `no hay un primario disponible (...)` | Lo dice entre paréntesis | Tabla en `docs/procedimientos-falla.md` |
| Un target de Prometheus en `DOWN` | Exporter no levantado, puerto o clave | Comprobar el exporter en su propia PC primero (`localhost:<puerto>/metrics`) |

**Tailscale como plan B.** Si la red del lugar aísla a las PCs, Tailscale las une aunque estén en redes distintas: cada PC recibe una IP `100.x.x.x`. Se instala en las tres con la misma cuenta y se usan **esas** IPs en la tabla de papeles, en los scripts de red y en los `.env`. En Windows las reglas del script solo aceptan la red local; para aceptar también Tailscale:

```powershell
Set-NetFirewallRule -Group Boletera -RemoteAddress LocalSubnet,100.64.0.0/10
```

Tailscale tiene que quedar como red Privada en Windows (el script lo muestra).
