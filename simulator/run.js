// Simulador de transacciones de Boletera: lanza compras contra la API usando
// solo los endpoints de docs/api-contrato.md.
import { crearClienteApi } from './src/api.js';
import { escenarioNormal, prepararPreventa } from './src/escenarios.js';
import { correr } from './src/motor.js';
import { AYUDA, leerParametros } from './src/parametros.js';
import { guardar, imprimir, resumir } from './src/reporte.js';

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

const resumen = resumir(resultados, duracionMs, p);
imprimir(resumen);
console.log(`\nGuardado en ${await guardar(resumen, p.salida)}`);
// Código de salida 1 si hubo doble venta, para que no pase desapercibida
process.exit(resumen.doble_venta.repetidos.length ? 1 : 0);
