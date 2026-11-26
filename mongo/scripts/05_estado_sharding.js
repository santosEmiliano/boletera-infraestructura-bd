// Muestra cómo está el cluster fragmentado: shards y sus miembros, balanceador,
// colecciones fragmentadas y cuántos documentos tiene cada shard.
// Se corre en mongos (PC2), las veces que se quiera; no cambia nada:
//   docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/05_estado_sharding.js
// Sirve para la prueba de tolerancia a fallos: con una PC apagada, sus miembros
// salen como caídos pero cada shard sigue teniendo primario.

if (db.hello().msg !== "isdbgrid") {
  print("Este script se corre en mongos (puerto 27017), no en un shard ni en un config server.");
  quit(1);
}

const BASE = "boletera";
const config = db.getSiblingDB("config");

// 1. Shards y el estado de cada miembro de su replica set
print("Shards:");
const shards = db.adminCommand({ listShards: 1 }).shards;
if (shards.length === 0) print("  (ninguno; falta correr 04_configurar_sharding.js)");
for (const shard of shards) {
  print(`  ${shard._id}  ${shard.host}`);
  try {
    const conexion = new Mongo(`mongodb://${shard.host.split("/")[1]}/?replicaSet=${shard._id}`);
    const estado = conexion.getDB("admin").runCommand({ replSetGetStatus: 1 });
    for (const m of estado.members) {
      print(`    ${m.name.padEnd(12)} ${m.stateStr}`);
    }
    conexion.close();
  } catch (e) {
    print(`    no se pudo consultar: ${e.message}`);
  }
}

// 2. Balanceador: es el que mueve trozos entre shards si uno se carga más
print(`\nBalanceador: ${sh.getBalancerState() ? "encendido" : "apagado"}`);

// 3. Colecciones fragmentadas y documentos por shard
print("\nColecciones fragmentadas:");
const colecciones = config.collections.find({ _id: { $regex: `^${BASE}\\.` } }).toArray();
if (colecciones.length === 0) print("  (ninguna)");
for (const c of colecciones) {
  const nombre = c._id.slice(BASE.length + 1);
  print(`  ${c._id}  clave ${JSON.stringify(c.key)}`);
  // $collStats en mongos devuelve un documento por shard que tiene la colección
  const porShard = db.getSiblingDB(BASE)[nombre]
    .aggregate([{ $collStats: { count: {} } }])
    .toArray();
  const total = porShard.reduce((suma, s) => suma + s.count, 0);
  for (const s of porShard.sort((a, b) => a.shard.localeCompare(b.shard))) {
    const porcentaje = total ? ((s.count / total) * 100).toFixed(1) : "0.0";
    print(`    ${s.shard}  ${String(s.count).padStart(8)} documentos  (${porcentaje}%)`);
  }
  print(`    total   ${String(total).padStart(8)}`);
}
