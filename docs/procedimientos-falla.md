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

## PostgreSQL

Pendiente: lo documenta quien administra PostgreSQL (promoción de la réplica de pc3 si cae pc2). La API usa un solo host (`PG_HOST`), así que después de promover hay que cambiarlo y reiniciarla.

## MongoDB

Los config servers (`cfgRS`) se reincorporan solos al reiniciar. Ver `docs/mongo-config-servers.md`.
