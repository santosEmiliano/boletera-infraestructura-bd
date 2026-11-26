// Agrega los dos shards al cluster y fragmenta las 5 colecciones de boletera.
// Se corre en mongos (PC2), cuando cfgRS, shardA y shardB ya están iniciados:
//   docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/04_configurar_sharding.js
// Se puede volver a correr: lo que ya está hecho se salta.
//
// El orden importa: primero los dos shards y después las colecciones, todavía
// vacías. Con clave hashed y colección vacía, MongoDB reparte los trozos
// iniciales entre los dos shards desde el principio; si se fragmentara con un
// solo shard, todo empezaría en él (decisión 10). El seed va después, por mongos.

if (db.hello().msg !== "isdbgrid") {
  print("Este script se corre en mongos (puerto 27017), no en un shard ni en un config server.");
  quit(1);
}

const SHARDS = [
  "shardA/pc1:27018,pc2:27018,pc3:27018",
  "shardB/pc1:27020,pc2:27020,pc3:27020",
];

// Claves hashed (decisión 9): reparten parejo y no mandan todo lo nuevo al
// mismo shard, como pasaría con una clave por fecha.
const COLECCIONES = {
  eventos: { _id: "hashed" },
  resenas: { evento_id: "hashed" },
  actividad_usuarios: { cliente_id: "hashed" },
  bitacora_accesos: { evento_id: "hashed" },
  notificaciones: { cliente_id: "hashed" },
};

const BASE = "boletera";

// 1. Shards
const existentes = db.adminCommand({ listShards: 1 }).shards.map((s) => s._id);
for (const shard of SHARDS) {
  const nombre = shard.split("/")[0];
  if (existentes.includes(nombre)) {
    print(`${nombre} ya estaba agregado`);
  } else {
    sh.addShard(shard);
    print(`${nombre} agregado`);
  }
}

// 2. Base y colecciones
sh.enableSharding(BASE);
const config = db.getSiblingDB("config");
for (const [coleccion, clave] of Object.entries(COLECCIONES)) {
  const ns = `${BASE}.${coleccion}`;
  if (config.collections.findOne({ _id: ns })) {
    print(`${ns} ya estaba fragmentada`);
    continue;
  }
  sh.shardCollection(ns, clave);
  print(`${ns} fragmentada por ${JSON.stringify(clave)}`);
}

// 3. Resumen: cuántos trozos (chunks) tiene cada colección en cada shard
print("\nTrozos por colección y shard:");
config.chunks.aggregate([
  { $lookup: { from: "collections", localField: "uuid", foreignField: "uuid", as: "col" } },
  { $unwind: "$col" },
  { $match: { "col._id": { $regex: `^${BASE}\\.` } } },
  { $group: { _id: { coleccion: "$col._id", shard: "$shard" }, trozos: { $sum: 1 } } },
  { $sort: { "_id.coleccion": 1, "_id.shard": 1 } },
]).forEach((d) => print(`  ${d._id.coleccion.padEnd(30)} ${d._id.shard}  ${d.trozos}`));
