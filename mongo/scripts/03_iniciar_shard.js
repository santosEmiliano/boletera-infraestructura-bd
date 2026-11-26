// Inicia el replica set de un shard con sus tres miembros (uno por PC).
// Sirve para los dos shards: toma el nombre (shardA o shardB) y el puerto del
// nodo al que se conecta. Se corre una sola vez por shard, desde pc2:
//   docker exec -it mongo-shard-a-pc2 mongosh --port 27018 --file /scripts/03_iniciar_shard.js
//   docker exec -it mongo-shard-b-pc2 mongosh --port 27020 --file /scripts/03_iniciar_shard.js
// Si el shard ya estaba iniciado, avisa y no cambia nada.
const opciones = db.adminCommand({ getCmdLineOpts: 1 }).parsed;
// Con --replSet en la línea de comandos el campo se llama replSet; en un archivo
// de configuración se llamaría replSetName. Se aceptan los dos.
const nombre = opciones.replication?.replSet ?? opciones.replication?.replSetName;
const puerto = opciones.net.port;

if (opciones.sharding?.clusterRole !== "shardsvr") {
  print(`El nodo del puerto ${puerto} no es un shard (¿es el config server o mongos?). No se hizo nada.`);
  quit(1);
}

try {
  rs.status();
  print(`${nombre} ya estaba iniciado`);
} catch (e) {
  printjson(rs.initiate({
    _id: nombre,
    members: [
      { _id: 0, host: `pc1:${puerto}` },
      { _id: 1, host: `pc2:${puerto}` },
      { _id: 2, host: `pc3:${puerto}` },
    ],
  }));
}
