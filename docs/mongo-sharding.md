# Sharding de MongoDB

El cluster reparte los documentos de cada colección entre dos shards, `shardA` y `shardB`. Cada shard es un replica set de tres miembros, uno por PC, así que cada mitad de los datos está copiada en las tres PCs y aguanta la caída de una. La API y el seed no se conectan a los shards: se conectan a `mongos`, que consulta el mapa de los config servers (`docs/mongo-config-servers.md`) y manda cada operación al shard que le toca.

| Proceso | Puerto | Dónde |
|---|---|---|
| `cfgRS` (config servers) | 27019 | PC1, PC2 y PC3 |
| `shardA` | 27018 | PC1, PC2 y PC3 |
| `shardB` | 27020 | PC1, PC2 y PC3 |
| `mongos` | 27017 | PC2 |

Todo está en `infra/pcX/mongo.yml`. El de PC2 es el único que lleva `mongos`.

## Levantar

En cada PC, con el `.env` de esa carpeta (las tres IPs):

```bash
docker compose -f infra/pcX/mongo.yml up -d
```

`mongos` arranca aunque los config servers todavía no estén iniciados: sigue intentando conectarse hasta que lo estén.

## Iniciar

Una sola vez, en este orden, cuando los contenedores de las tres PCs estén arriba.

1. Config servers, desde PC1:

```bash
docker exec -it mongo-cfg-pc1 mongosh --port 27019 --file /scripts/01_iniciar_config.js
```

2. `shardA`, desde PC2:

```bash
docker exec -it mongo-shard-a-pc2 mongosh --port 27018 --file /scripts/03_iniciar_shard.js
```

3. `shardB`, desde PC2:

```bash
docker exec -it mongo-shard-b-pc2 mongosh --port 27020 --file /scripts/03_iniciar_shard.js
```

4. Esperar unos 15 segundos a que cada replica set elija primario. Después, en `mongos`, agregar los shards y fragmentar las colecciones:

```bash
docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/04_configurar_sharding.js
```

El 03 sirve para los dos shards: toma el nombre y el puerto del nodo al que se conecta. El 04 agrega los dos shards y después fragmenta las cinco colecciones, todavía vacías. Los dos se pueden volver a correr: lo que ya está hecho se salta.

El seed va después del paso 4 y siempre por `mongos` (`mongodb://pc2:27017/boletera`). Si se insertara antes de fragmentar, todo quedaría en un solo shard.

## Colecciones y shard keys

| Colección | Shard key |
|---|---|
| `eventos` | `{ _id: "hashed" }` |
| `resenas` | `{ evento_id: "hashed" }` |
| `actividad_usuarios` | `{ cliente_id: "hashed" }` |
| `bitacora_accesos` | `{ evento_id: "hashed" }` |
| `notificaciones` | `{ cliente_id: "hashed" }` |

Todas son hashed: MongoDB calcula un hash de la clave y reparte por ese hash, así que los documentos quedan parejos entre los dos shards. Con una clave por rangos, como la fecha, todos los documentos nuevos irían al mismo shard. La justificación de cada clave está en `docs/arquitectura.md`, sección 4.

## Verificar

```bash
docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/05_estado_sharding.js
```

Muestra los miembros de cada shard con su estado (`PRIMARY`, `SECONDARY` o no alcanzable), si el balanceador está encendido y, por colección, cuántos documentos tiene cada shard. Solo lee; se puede correr las veces que se quiera.

## Si una PC se cae

Se caen a la vez sus tres miembros: el de `cfgRS`, el de `shardA` y el de `shardB`. Cada replica set sigue con los otros dos, que son mayoría:

- Si el miembro caído era primario, los otros dos eligen uno nuevo en unos segundos. No hay que ejecutar nada.
- `mongos` se entera solo de quién es el primario nuevo y las lecturas y escrituras siguen.
- Al volver, la PC se reincorpora como `SECONDARY` y se pone al día sola. El primario no regresa a ella.

Si se caen dos PCs, los replica sets se quedan sin mayoría y dejan de aceptar escrituras hasta que vuelva una. Si la que se cae es PC2, se pierde `mongos` y la API no tiene a dónde conectarse aunque los datos sigan completos en PC1 y PC3.

## Simulación en una sola máquina

`infra/simulacion/mongo.yml` levanta tres contenedores, `pc1`, `pc2` y `pc3`, que corren cada uno sus tres `mongod`, más un contenedor de `mongos`. Detener un contenedor equivale a apagar una PC. Los scripts se usan sin cambios; solo cambian los nombres de los contenedores:

```bash
cd infra/simulacion
docker compose -f mongo.yml up -d
docker exec -it sim-mongo-pc1 mongosh --port 27019 --file /scripts/01_iniciar_config.js
docker exec -it sim-mongo-pc2 mongosh --port 27018 --file /scripts/03_iniciar_shard.js
docker exec -it sim-mongo-pc2 mongosh --port 27020 --file /scripts/03_iniciar_shard.js
docker exec -it sim-mongos mongosh --file /scripts/04_configurar_sharding.js
docker exec -it sim-mongos mongosh --file /scripts/05_estado_sharding.js
```

`mongos` se publica en el puerto 27027 de la máquina, para no chocar con otro MongoDB en 27017. Para borrar todo, incluidos los datos de prueba:

```bash
docker compose -f mongo.yml down -v
```

## Evidencia

Ensayo en la simulación, con 10,000 eventos y 10,000 reseñas (500 `evento_id` distintos) insertados por `mongos`:

| Prueba | Resultado |
|---|---|
| `04_configurar_sharding.js` con las colecciones vacías | Las 5 colecciones con 2 trozos en `shardA` y 2 en `shardB` |
| Reparto de `eventos` | `shardA` 50.9 %, `shardB` 49.0 % |
| Reparto de `resenas` | `shardA` 52.0 %, `shardB` 48.0 % |
| `docker stop` de PC1 (sin primarios) | Sus miembros quedan no alcanzables; 1,000 eventos más se insertan sin error (total 11,000) |
| PC1 de regreso | Sus miembros vuelven como `SECONDARY` |
| `docker stop` de PC3 (primario de los dos shards) | `shardA` elige primario en PC2 y `shardB` en PC1 |
| PC3 de regreso | Sus miembros vuelven como `SECONDARY`; los primarios se quedan en PC2 y PC1 |

Falta repetirlo en la red real entre PCs, incluida una escritura después de la elección de primario.

## Notas

- `--wiredTigerCacheSizeGB 0.25` en cada `mongod`, igual que en los config servers: cada PC corre tres.
- Los shards se agregan con los tres miembros (`shardA/pc1:27018,pc2:27018,pc3:27018`). Así `mongos` conoce el replica set completo y encuentra al primario aunque cambie.
