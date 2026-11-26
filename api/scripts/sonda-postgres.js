// Escribe en PostgreSQL cada 100 ms con el mismo pool que usa la API
// (src/postgres-primario.js) y muestra cada segundo cuántas escrituras salieron,
// cuántas fallaron y en qué nodo. Sirve para ver y medir un failover: cuánto
// tiempo pasa desde la primera escritura fallida hasta la siguiente que sale.
//
//   cd api
//   node --env-file=.env scripts/sonda-postgres.js
//
// Toma PG_HOSTS, PG_PORT, PG_USER, PG_PASSWORD y PG_DATABASE igual que la API.
// El usuario necesita CREATE en el esquema public (postgres sirve). Escribe en su
// propia tabla, sonda_failover; al terminar se borra con DROP TABLE sonda_failover.
// Ctrl+C para terminar y ver el resumen.
import { pgPool } from '../src/db.js';

const CADA_MS = 100;
const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));
const hora = () => new Date().toTimeString().slice(0, 8);

await pgPool.query(`CREATE TABLE IF NOT EXISTS sonda_failover (
  id        BIGSERIAL PRIMARY KEY,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

let ok = 0;
let fallas = 0;
const codigos = new Map();
let totalOk = 0;
let totalFallas = 0;
// La caída se mide desde la última escritura que salió, no desde la primera que
// falló: mientras la API busca al primario, la escritura se queda esperando hasta
// 5 s antes de fallar, y ese tiempo también es caída
let ultimoOk = null;
let caidaMasLarga = 0;
const UMBRAL_MS = 1000;

const reporte = setInterval(() => {
  const errores = [...codigos].map(([c, n]) => `${c} x${n}`).join(', ');
  console.log(`${hora()}  ok ${String(ok).padStart(3)}  fallas ${String(fallas).padStart(3)}  primario ${pgPool.primarioActual()}${errores ? `  (${errores})` : ''}`);
  ok = 0;
  fallas = 0;
  codigos.clear();
}, 1000);

let seguir = true;
process.on('SIGINT', () => { seguir = false; });

while (seguir) {
  try {
    await pgPool.query('INSERT INTO sonda_failover DEFAULT VALUES');
    ok++;
    totalOk++;
    const ahora = Date.now();
    // Más de un segundo sin escribir (lo normal son 100 ms): hubo caída
    if (ultimoOk && ahora - ultimoOk > UMBRAL_MS) {
      const segundos = (ahora - ultimoOk) / 1000;
      caidaMasLarga = Math.max(caidaMasLarga, segundos);
      console.log(`${hora()}  >> caída de ${segundos.toFixed(1)} s sin escribir; se volvió a escribir en ${pgPool.primarioActual()}`);
    }
    ultimoOk = ahora;
  } catch (e) {
    fallas++;
    totalFallas++;
    const codigo = e.code ?? e.message.slice(0, 40);
    codigos.set(codigo, (codigos.get(codigo) ?? 0) + 1);
    if (fallas === 1) console.log(`${hora()}  >> escritura fallida: ${e.message}`);
  }
  await dormir(CADA_MS);
}

clearInterval(reporte);
const enCurso = ultimoOk && Date.now() - ultimoOk > UMBRAL_MS;
console.log(`\nEscrituras: ${totalOk} bien, ${totalFallas} fallidas. Caída más larga: ${caidaMasLarga.toFixed(1)} s${enCurso ? ' (y había una caída en curso)' : ''}.`);
await pgPool.end().catch(() => {});
process.exit(0);
