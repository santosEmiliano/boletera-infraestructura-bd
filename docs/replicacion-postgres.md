# Replicación de PostgreSQL (Streaming Replication)

Dos nodos. PC2 es el **primario**: recibe todas las escrituras. PC3 es la **réplica**: recibe el WAL del primario en cuanto se genera, lo aplica y solo permite lecturas. La replicación es física (copia el servidor completo, con roles, particiones e índices) y asíncrona (el primario no espera a la réplica para confirmar una transacción).

Si PC2 cae, PC3 no toma el lugar sola: se promueve a mano con `pg_promote()`. Después, PC2 vuelve como réplica de PC3.

La réplica se conecta con el rol `replicator` al puerto 5432 de `pc2`, usando el slot `replica_pc3`.

## Antes de empezar

- PC2 con PostgreSQL arriba, el esquema y los datos cargados (`postgres/README.md`).
- Los nombres `pc2` y `pc3` deben resolverse desde los contenedores (variables `PCX_IP` del `.env`) y el puerto 5432 abierto en el firewall de PC2.
- La misma `REPLICATOR_PASSWORD` en el `.env` de PC2 y de PC3.
- En PC3, el volumen `boletera_pgdata` vacío. Si es de una prueba anterior: `docker compose -f infra/pc3/postgres.yml down -v`.

Los comandos se corren desde la raíz del repo. En PowerShell van en una sola línea.

## Preparar el primario (PC2)

Los parámetros de replicación (`wal_level=replica`, `max_wal_senders`, `max_replication_slots`, `hot_standby`) ya están en el `command` de `infra/pc2/postgres.yml`, y la regla de `pg_hba.conf` para `replicator` se agrega sola en el primer arranque (`postgres/init/02_pg_hba_replicacion.sh`).

Falta el rol y el slot, con la clave de `REPLICATOR_PASSWORD`:

```bash
docker exec postgres-pc2 psql -U postgres -d boletera -v ON_ERROR_STOP=1 -v replicator_clave=... -f /scripts/03_replicacion.sql
```

Al final debe salir `replica_pc3 | physical | f`: el slot existe y todavía no lo usa nadie.

## Copiar el primario en la réplica (PC3)

Con el volumen vacío, `pg_basebackup` copia PC2 completo desde un contenedor de un solo uso:

```bash
docker compose -f infra/pc3/postgres.yml run --rm --no-deps --user postgres -e PGPASSWORD=... postgres pg_basebackup -h pc2 -U replicator -D /var/lib/postgresql/data -Fp -Xs -P -R -S replica_pc3
```

- `-Xs` copia también el WAL que se genera mientras dura la copia.
- `-R` crea `standby.signal` y escribe en `postgresql.auto.conf` cómo conectarse al primario (`primary_conninfo` y `primary_slot_name`). Con eso el contenedor arranca como réplica.
- **No escribir nada en la terminal hasta que salga el 100 % y regrese el prompt.** Un `Ctrl+C` a medias deja el volumen incompleto y hay que borrarlo y repetir.

Después se levanta la réplica:

```bash
docker compose -f infra/pc3/postgres.yml up -d
```

## Verificar

En PC2, la réplica conectada:

```bash
docker exec postgres-pc2 psql -U postgres -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
```

En PC3, que está en modo réplica (`t`) y tiene las particiones y los datos:

```bash
docker exec postgres-pc3 psql -U postgres -c "SELECT pg_is_in_recovery();"
```

```bash
docker exec postgres-pc3 psql -U postgres -d boletera -f /scripts/01_verificar_particiones.sql
```

| Prueba | Resultado esperado |
|---|---|
| `pg_stat_replication` en PC2 | Una fila con `streaming` y `async` |
| `pg_is_in_recovery()` en PC3 | `t` |
| Verificación de particiones en PC3 | Las 8 particiones, 10,000 asientos en cada una y la misma poda que en PC2 |
| Insertar en PC2 | La fila aparece en PC3 |
| Insertar en PC3 | Falla con `cannot execute INSERT in a read-only transaction`. Es lo normal |
| Detener la réplica (`docker stop postgres-pc3`) | PC2 sigue funcionando. Al volver a levantarla se pone al día sola, porque el slot guardó el WAL que le faltaba |

## Failover: cae el primario

1. PC2 deja de responder (en la prueba: `docker stop postgres-pc2`). Las compras fallan.
2. Promover la réplica. Debe salir `t`:

   ```bash
   docker exec postgres-pc3 psql -U postgres -c "SELECT pg_promote();"
   ```

3. Comprobar que ya no es réplica (`f`) y que acepta escrituras:

   ```bash
   docker exec postgres-pc3 psql -U postgres -c "SELECT pg_is_in_recovery();"
   ```

4. La API lo encuentra sola si tiene los dos nodos en `PG_HOSTS=pc2,pc3`: pregunta `pg_is_in_recovery()` a cada uno y cambia al que responde `false`, sin reiniciarse. Con un solo host (`PG_HOST=pc2`), hay que cambiarlo a `pc3` y reiniciarla. Detalle y tiempos medidos: `docs/procedimientos-falla.md`.

Al promoverse, PC3 borra `standby.signal` y deja de buscar a PC2. No necesita reiniciarse: ya tiene los parámetros de replicación y la regla de `pg_hba.conf`, que se copiaron de PC2.

## Regresar el viejo primario como réplica

PC2 no puede volver como primario ni retomar donde se quedó: PC3 siguió escribiendo después de promoverse y las dos historias ya no coinciden. Se vuelve a copiar completo desde PC3. `pg_rewind` evitaría la copia completa, pero necesita `wal_log_hints=on` o checksums, y no están activados.

1. En PC3, crear el slot de la nueva réplica. Los slots no viajan con la replicación:

   ```bash
   docker exec postgres-pc3 psql -U postgres -c "SELECT pg_create_physical_replication_slot('replica_pc2');"
   ```

2. En PC2, borrar el volumen viejo. Se pierden los datos de PC2, que ya están en PC3:

   ```bash
   docker compose -f infra/pc2/postgres.yml down -v
   ```

3. En PC2, copiar PC3 en el volumen vacío y levantar:

   ```bash
   docker compose -f infra/pc2/postgres.yml run --rm --no-deps --user postgres -e PGPASSWORD=... postgres pg_basebackup -h pc3 -U replicator -D /var/lib/postgresql/data -Fp -Xs -P -R -S replica_pc2
   ```

   ```bash
   docker compose -f infra/pc2/postgres.yml up -d
   ```

   El esquema de `postgres/init` no se vuelve a correr porque el volumen ya trae datos.

4. Verificar al revés: `pg_stat_replication` en PC3 y `pg_is_in_recovery()` = `t` en PC2.

Ahora PC3 es el primario y PC2 la réplica. Para volver a los papeles originales se repite el failover en sentido contrario.

## Ensayo en una sola máquina

`infra/simulacion/postgres.yml` levanta los dos nodos en una red de Docker (contenedores `sim-pc2` en el puerto 5433 y `sim-pc3` en el 5434), con su propio `.env`. Los pasos son los mismos con estas diferencias:

- Los servicios se llaman `pc2` y `pc3`, no `postgres`: `docker compose -f infra/simulacion/postgres.yml up -d pc2`, `... run ... pc3 pg_basebackup -h pc2 ...`.
- Los contenedores se llaman `sim-pc2` y `sim-pc3`.
- Para empezar de cero: `docker compose -f infra/simulacion/postgres.yml down -v`.

## Problemas que ya aparecieron

**`pg_basebackup` interrumpido.** Si se escribe en la terminal mientras corre, un `Ctrl+C` lo corta. Hay que esperar al 100 %.

**Scripts `.sh` con fin de línea CRLF.** Con `core.autocrlf=true` en Windows, git convierte los `.sh` a CRLF y dentro del contenedor fallan con `\r: command not found`. El `.gitattributes` del repo los fuerza a LF.

**El WAL crece en el primario si la réplica no vuelve.** El slot guarda todo lo que la réplica no ha recibido. Si una réplica se da de baja para siempre, borrar su slot: `SELECT pg_drop_replication_slot('replica_pc3');`.

## Cómo se probó

Ensayo con la simulación local: esquema y seed en `sim-pc2` (98,089 filas), rol y slot, `pg_basebackup` (47,678 kB) y réplica en `streaming`/`async`. En `sim-pc3` las 8 particiones con los mismos conteos y la misma poda, e INSERT rechazado. Caída del primario, `pg_promote()` y escritura aceptada en PC3. Regreso de PC2 como réplica de PC3 con el slot `replica_pc2`: una fila insertada en PC3 apareció en PC2 (38,332 movimientos) y el INSERT en PC2 se rechazó.

Cambio de primario con el pool de la API (`PG_HOSTS` con los dos nodos) y la sonda escribiendo cada 100 ms: 13 segundos sin escrituras desde el `docker stop` del primario, y menos de uno entre el `pg_promote()` y la primera escritura en PC3, sin reiniciar la API.

Lo que falta probar: el paso por la red real entre PCs (con Docker Desktop la IP de origen puede no ser la de la otra PC, por eso la regla de `pg_hba.conf` acepta cualquier origen) y la caída con la API completa y el simulador de compras en marcha.
