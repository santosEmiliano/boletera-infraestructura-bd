# Config servers de MongoDB

Los config servers guardan el mapa del cluster, qué colecciones están fragmentadas, con qué clave y en qué shard vive cada trozo. Sin ellos, Mongo no sabe a dónde mandar las consultas. Por eso son un replica set de tres miembros (`cfgRS`), uno por PC, y aguantan la caída de uno.

Puerto: 27019. Cada PC lo levanta con `infra/pcX/mongo.yml`. Ese mismo archivo es donde se agregan después los shards y `mongos`.

## Levantar

En cada PC:

```bash
docker compose -f infra/pcX/mongo.yml up -d
```

Antes hace falta el `.env` de esa carpeta, con las tres IPs, para que `pc1`, `pc2` y `pc3` se resuelvan desde los contenedores. El mismo `.env` sirve para MySQL.

## Iniciar el replica set

Solo una vez, desde pc1, cuando los tres contenedores estén arriba:

```bash
docker exec -it mongo-cfg-pc1 mongosh --port 27019 --file /scripts/01_iniciar_config.js
```

Si se corre otra vez, avisa que ya estaba iniciado y no cambia nada.

## Verificar

```bash
docker exec -it mongo-cfg-pc1 mongosh --port 27019 --file /scripts/02_estado_config.js
```

Esperado:

```
pc1:27019    PRIMARY    salud: 1
pc2:27019    SECONDARY  salud: 1
pc3:27019    SECONDARY  salud: 1
```

## Si un nodo se cae

Al detener el primario, uno de los otros dos pasa a PRIMARY. Al volver a levantar el nodo caído, se reincorpora solo como SECONDARY. A diferencia de MySQL, no hay que ejecutar nada. Si se caen dos nodos, el replica set deja de aceptar escrituras hasta que vuelva uno.

## Notas

- `--wiredTigerCacheSizeGB 0.25` limita la memoria caché de cada proceso. Sin esto, MongoDB intenta usar casi la mitad de la RAM de la PC, y en cada PC correrán varios procesos de Mongo.