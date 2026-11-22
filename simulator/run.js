// Simulador de transacciones de Boletera: lanza compras contra la API usando
// solo los endpoints de docs/api-contrato.md.
import { crearClienteApi } from './src/api.js';
import { escenarioNormal, prepararPreventa, revisarDobleVenta } from './src/escenarios.js';
import { correr } from './src/motor.js';
import { AYUDA, leerParametros } from './src/parametros.js';

let p;
try {
  p = leerParametros();
} catch (e) {
  console.error(`${e.message}\n\n${AYUDA}`);
  process.exit(1);
}
if (p.ayuda) {
  console.log(AYUDA);
  process.exit(0);
}

const cuanto = p.duracion ? `durante ${p.duracion} s` : `${p.compras} compras`;
console.log(`Escenario ${p.escenario}, ${cuanto}, ${p.concurrencia} a la vez, contra ${p.url}`);

const api = crearClienteApi(p.url);
let unaCompra = escenarioNormal(api);
if (p.escenario === 'preventa') {
  try {
    const preventa = await prepararPreventa(api, p);
    unaCompra = preventa.unaCompra;
    console.log(`En disputa: ${preventa.disputados.length} asientos de la función ${p.funcion} (sede ${preventa.sedeId})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
const { resultados, duracionMs } = await correr(p, unaCompra);

// Resumen provisional, hasta que exista el reporte
const porStatus = {};
for (const r of resultados) {
  const clave = `${r.fase} ${r.status || r.error}`;
  porStatus[clave] = (porStatus[clave] ?? 0) + 1;
}
console.log(`${resultados.length} compras en ${(duracionMs / 1000).toFixed(1)} s`, porStatus);

const { vendidos, repetidos } = revisarDobleVenta(resultados);
console.log(`Asientos vendidos: ${vendidos}. Doble venta: ${repetidos.length}`, repetidos.length ? repetidos : '');
