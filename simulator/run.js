// Simulador de transacciones de Boletera: lanza compras contra la API usando
// solo los endpoints de docs/api-contrato.md.
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
