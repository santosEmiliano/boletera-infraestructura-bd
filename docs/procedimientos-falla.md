# Qué hacer cuando algo falla

Esta guía cubre las fallas que ya se ensayaron. Cada sección dice qué pasa solo, qué hay que hacer a mano y cómo comprobar que quedó bien.

## MySQL: cae el primario

Es la falla más probable. El grupo tiene tres nodos y aguanta la caída de uno.

**Qué pasa solo**

1. Los dos nodos restantes eligen un primario nuevo. Tarda unos 5 segundos.
2. La API lo encuentra sin reiniciarse. Con `MYSQL_HOSTS=pc1,pc2,pc3` pregunta a cada nodo si es el primario (rol `PRIMARY`, estado `ONLINE` y sin `super_read_only`) y cambia sus conexiones al que responda que sí. Mientras no haya primario, las compras esperan hasta 15 segundos en vez de fallar.
3. La API repite esa pregunta al arrancar y cada 2 segundos al nodo que usa. Así detecta un nodo que dejó de ser primario aunque no dé ningún error (ver "Un nodo que reinicia" más abajo).

**Lo que se midió** (ensayo con el grupo de 3 nodos en contenedores, 6 compras a la vez, deteniendo o reiniciando el primario a los 8 segundos): 6,000 compras de 6,000 con 201 en las tres corridas, sin asientos vendidos dos veces. La compra más lenta tardó entre 5.2 y 5.3 segundos, que es lo que tarda el grupo en elegir. Aun así, en cada corrida quedó una orden `pendiente` duplicada: ver `docs/compras.md`, "Límites conocidos".

**Cómo comprobar**

```bash
docker exec -it mysql-pcX mysql -uroot -p
```

```sql
source /scripts/04_estado.sql
```

Debe haber un `PRIMARY` y dos `SECONDARY` en `ONLINE`. En los registros de la API aparece una línea `MySQL: el primario ahora es pcX`.

## MySQL: volver a levantar un nodo

Un nodo que se detuvo o se reinició **no se une solo** al grupo (`start_on_boot=OFF`). Queda `OFFLINE`, y además acepta escrituras porque ya no está bajo el control del grupo. Nadie debe escribirle: la API no lo hace, pero un `mysql` abierto a mano sí podría.

```sql
START GROUP_REPLICATION;
```

El nodo se pone al día con lo que se perdió y vuelve como `SECONDARY`. En el ensayo, un nodo que estuvo caído mientras se hacían 6,000 compras terminó con todas las órdenes.

Si se reinician los tres nodos a la vez, se vuelve a formar el grupo como se explica en `docs/replicacion-mysql.md` (`02_arrancar_grupo.sql` en un solo nodo y luego se unen los otros dos).

## MySQL: la API dice que no hay primario

Los registros muestran `MySQL: no hay un primario disponible` y las compras responden 500.

1. Revisar el estado con `04_estado.sql` en cualquier nodo que responda.
2. Si no hay ningún `PRIMARY`, el grupo perdió la mayoría (dos de tres nodos caídos). Levantar los nodos y unirlos con `START GROUP_REPLICATION;`. Si no se puede, formar el grupo de nuevo.
3. Si sí hay un `PRIMARY` y la API no lo ve, comprobar que `MYSQL_HOSTS` tenga los tres nodos, que los nombres se resuelvan desde donde corre la API y que el usuario `boletera_api` tenga el permiso de abajo.

**Respaldo manual.** Dejar solo el primario en `MYSQL_HOSTS` (por ejemplo `MYSQL_HOSTS=pc2`) y reiniciar la API. Funciona, pero hay que repetirlo en cada cambio de primario.

## MySQL: permiso para encontrar al primario

`boletera_api` necesita leer `performance_schema.replication_group_members`. `mysql/scripts/03_usuarios.sql` ya lo incluye. En un grupo que se creó antes de ese cambio, correrlo una vez en el primario (se replica solo):

```sql
GRANT SELECT ON performance_schema.replication_group_members TO 'boletera_api'@'%';
```

Sin ese permiso la API no puede preguntar quién es el primario y se comporta como antes: si el primario cambia, hay que reiniciarla.

## Un nodo que reinicia

Si se reinicia el contenedor o la PC de un nodo, vuelve fuera del grupo y con `super_read_only` apagado, así que acepta escrituras de cualquiera que se conecte. La API lo descarta porque solo usa un nodo cuyo rol sea `PRIMARY` y esté `ONLINE`. Se ensayó: con un nodo así como primer host de la API, y reiniciando el primario con carga, la API terminó en un nodo del grupo y el nodo aislado no recibió ninguna orden.

## PostgreSQL: cae el primario

PostgreSQL tiene un primario (PC2) y una réplica de solo lectura (PC3). A diferencia de MySQL y Mongo, **la réplica no se promueve sola**: con dos nodos no hay mayoría que decida, y un failover automático podría dejar dos primarios si solo se corta la red (`docs/arquitectura.md`, sección 3.7). La promoción es el único paso manual.

**Qué pasa solo**

1. Las conexiones a PC2 se cortan. Cada operación de la API busca al primario durante 5 segundos y, como todavía no hay, responde `SIN_PRIMARIO`: las compras fallan con 500.
2. En cuanto PC3 se promueve, la API lo encuentra sin reiniciarse. Con `PG_HOSTS=pc2,pc3` pregunta `SELECT pg_is_in_recovery()` a cada nodo y cambia sus conexiones al que responde `false` (`api/src/postgres-primario.js`). En los registros aparece `PostgreSQL: el primario ahora es pc3 (antes pc2)`.

**Qué hacer a mano**

1. Confirmar que PC2 de verdad no responde (no es un corte de red de unos segundos). Si PC2 sigue vivo y se promueve PC3, quedan dos primarios.
2. Promover PC3. Debe salir `t`:

   ```bash
   docker exec postgres-pc3 psql -U postgres -c "SELECT pg_promote();"
   ```

3. Comprobar que ya no es réplica (`f`):

   ```bash
   docker exec postgres-pc3 psql -U postgres -c "SELECT pg_is_in_recovery();"
   ```

4. **No volver a levantar PC2 tal como estaba.** Se reconstruye como réplica de PC3 (abajo). Si arrancara con sus datos viejos, también diría ser primario.

**Lo que se midió** (simulación local, `api/scripts/sonda-postgres.js` escribiendo cada 100 ms con el pool de la API, `docker stop` del primario y `pg_promote()` unos 10 segundos después): 13 segundos sin escrituras, casi todos de espera antes de promover. Entre el `pg_promote()` y la primera escritura en PC3 pasó menos de un segundo, sin reiniciar la API. Para medirlo en la red real:

```bash
cd api
node --env-file=.env scripts/sonda-postgres.js
```

La sonda necesita un usuario con `CREATE` (por ejemplo `PG_USER=postgres`) y escribe en su propia tabla; al terminar se borra con `DROP TABLE sonda_failover;`.

## PostgreSQL: regresar el viejo primario

PC2 no puede volver a ser primario ni retomar donde se quedó: PC3 siguió escribiendo y las dos historias ya no coinciden. Se copia completo desde PC3 y queda como su réplica. Los comandos están en `docs/replicacion-postgres.md`, "Regresar el viejo primario como réplica":

1. En PC3, crear el slot `replica_pc2`.
2. En PC2, `docker compose -f infra/pc2/postgres.yml down -v` (los datos de PC2 ya están en PC3).
3. En PC2, `pg_basebackup` desde `pc3` con el slot `replica_pc2` y levantar.
4. Comprobar `pg_stat_replication` en PC3 y `pg_is_in_recovery()` = `t` en PC2.

La API no necesita nada: sigue en PC3, y PC2 responde `true` (réplica), así que no lo elige.

## PostgreSQL: la API dice que no hay primario

Los registros muestran `PostgreSQL: no hay un primario disponible (pc2: ...; pc3: ...)`, con la causa de cada nodo.

| Causa en el mensaje | Qué significa | Qué hacer |
|---|---|---|
| `ECONNREFUSED`, `timeout` en los dos | Ningún nodo responde | Levantar el que se pueda; si es la réplica, promoverla |
| Uno responde y el otro no, sin promover | El primario cayó y la réplica sigue siendo réplica | Promover PC3 (arriba) |
| `password authentication failed` | `PG_USER` o `PG_PASSWORD` equivocados | Corregir el `.env` de la API |

**Dos primarios.** Si el viejo primario volvió sin reconstruirse, los registros muestran `PostgreSQL: hay dos primarios (pc2, pc3)`. Si la API ya estaba usando uno de ellos, se queda con ese; si acaba de arrancar, no elige ninguno, para no escribir en el viejo. En los dos casos: detener el viejo (`docker stop postgres-pc2`) y reconstruirlo como réplica.

**Respaldo manual.** Dejar solo el primario en `PG_HOSTS` (por ejemplo `PG_HOSTS=pc3`) y reiniciar la API. Funciona, pero hay que repetirlo en cada cambio de primario.

## MongoDB

Los config servers (`cfgRS`) se reincorporan solos al reiniciar. Ver `docs/mongo-config-servers.md`.

## MongoDB: cae un miembro de un shard o una PC completa

Cada shard (`shardA` y `shardB`) es un replica set con un miembro en cada PC, igual que `cfgRS`. Si se cae una PC, se caen a la vez sus tres miembros, y cada replica set sigue con los otros dos, que son mayoría.

**Qué pasa solo**

1. Si el miembro caído era secundario, no cambia nada.
2. Si era primario, los otros dos eligen uno nuevo en unos segundos.
3. `mongos` se entera del primario nuevo y manda ahí las operaciones; la API no nota nada más que esos segundos.
4. Al volver, la PC se reincorpora como `SECONDARY` y se pone al día sola. El primario no regresa a ella.

No hay que ejecutar nada.

**Cómo comprobar**

```bash
docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/05_estado_sharding.js
```

Cada shard debe tener un `PRIMARY`; los miembros de la PC caída salen como `(not reachable/healthy)`. Justo después del `docker stop` pueden salir todavía como `SECONDARY`: los miembros se revisan cada 2 segundos, así que hay que esperar unos 15 antes de mirar.

**Lo que se midió** (simulación local, `infra/simulacion/mongo.yml`): con PC1 apagada se insertaron 1,000 documentos más sin error; al apagar PC3, que tenía los primarios de los dos shards, `shardA` eligió primario en PC2 y `shardB` en PC1; las dos PCs volvieron como `SECONDARY`. Detalle en `docs/mongo-sharding.md`.

**Si se caen dos PCs**, los replica sets se quedan sin mayoría: no hay primario y no se aceptan escrituras hasta que vuelva una de las dos. Se levanta y se reincorpora sola.

## MongoDB: cae mongos

Hay dos `mongos`, en PC2 y en PC1, y la API los tiene a los dos en `MONGO_URI` (`mongodb://pc2:27017,pc1:27017/boletera`).

**Qué pasa solo**

Si cae uno, el driver de Mongo de la API manda todo al otro, sin reiniciarse. Una escritura que estaba en camino al que cayó se reintenta sola en el otro (el driver reintenta las escrituras una vez por omisión).

**Lo que se midió** (simulación, `sim-mongos` y `sim-mongos2`): un cliente con los dos en la URI insertó un documento cada 200 ms durante 30 s; con `docker stop` de uno a media corrida, salieron las 150 inserciones sin ningún error.

**Qué hacer a mano**

Volver a levantar el que cayó, para recuperar el respaldo. No guarda datos, así que basta con:

```bash
docker compose -f infra/pcX/mongo.yml up -d mongos
```

**Si caen los dos**, la API no tiene a dónde conectarse aunque los datos sigan completos en los shards: la validación del evento falla y las compras responden 500. Las reseñas también fallan. El escaneo en la puerta sigue funcionando, porque lo decide MySQL, pero ese acceso no queda en `bitacora_accesos` (se avisa en consola). En cuanto uno responde, la API vuelve sola.

**Si cae PC2 completa**, se van a la vez su `mongos` y el primario de PostgreSQL. Mongo sigue por el `mongos` de PC1 y los shards con PC1 y PC3; PostgreSQL necesita el `pg_promote()` de PC3 (arriba). No se ha ensayado en la red real.
