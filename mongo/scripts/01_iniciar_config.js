// Se corre una sola vez, desde un solo nodo (pc1).
try {
  rs.status();
  print("cfgRS ya estaba iniciado");
} catch (e) {
  printjson(rs.initiate({
    _id: "cfgRS",
    configsvr: true,
    members: [
      { _id: 0, host: "pc1:27019" },
      { _id: 1, host: "pc2:27019" },
      { _id: 2, host: "pc3:27019" },
    ],
  }));
}
