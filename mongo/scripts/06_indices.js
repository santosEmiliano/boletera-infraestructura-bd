// Crea los índices de las colecciones que no son la shard key (mongo/seed/modelo.md).
// El índice de la shard key ya lo crea 04_configurar_sharding.js.
// Se corre en mongos (PC2), después del 04; puede ser antes o después del seed:
//   docker exec -it mongos-pc2 mongosh --port 27017 --file /scripts/06_indices.js
// Se puede volver a correr: createIndex no hace nada si el índice ya existe.

if (db.hello().msg !== "isdbgrid") {
  print("Este script se corre en mongos (puerto 27017), no en un shard ni en un config server.");
  quit(1);
}

const BASE = "boletera";

const INDICES = {
  eventos: [{ categoria: 1 }],
  resenas: [],
  actividad_usuarios: [{ cliente_id: 1, fecha: -1 }],
  bitacora_accesos: [],
  notificaciones: [{ cliente_id: 1, creada_en: -1 }],
};

// Si la colección no está fragmentada todavía, createIndex la crearía sin
// fragmentar, en un solo shard. Primero va el 04.
const config = db.getSiblingDB("config");
const faltan = Object.keys(INDICES).filter((c) => !config.collections.findOne({ _id: `${BASE}.${c}` }));
if (faltan.length > 0) {
  print(`Sin fragmentar: ${faltan.join(", ")}. Primero hay que correr 04_configurar_sharding.js.`);
  quit(1);
}

const base = db.getSiblingDB(BASE);
for (const [coleccion, indices] of Object.entries(INDICES)) {
  for (const clave of indices) {
    const nombre = base[coleccion].createIndex(clave);
    print(`${coleccion}: ${nombre}`);
  }
}

// Resumen: todos los índices de cada colección, incluidos _id y la shard key
print("\nÍndices por colección:");
for (const coleccion of Object.keys(INDICES)) {
  print(`  ${coleccion}`);
  for (const i of base[coleccion].getIndexes()) {
    print(`    ${i.name.padEnd(28)} ${JSON.stringify(i.key)}`);
  }
}
