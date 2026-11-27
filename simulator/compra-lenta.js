// Compras lentas para la demostración: hace una compra cada pocos segundos y
// muestra cada una en su propia línea, para poder tumbar nodos mientras corre y
// ver en vivo que el sistema sigue vendiendo. Corre hasta que se detiene con
// Ctrl+C; entonces muestra el resumen y revisa que ningún asiento se haya vendido
// dos veces.
//
//   node compra-lenta.js                       # una compra cada 2 s contra http://pc1:4000
//   node compra-lenta.js --cada 1              # una por segundo
//   node compra-lenta.js --url http://localhost:4000
//
// Usa la misma forma de elegir evento, función y asientos que el simulador.
import { crearClienteApi } from './src/api.js';
import { escenarioNormal, revisarDobleVenta } from './src/escenarios.js';

const args = process.argv.slice(2);
const valor = (nombre, omision) => {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : omision;
};
const URL = valor('--url', 'http://pc1:4000');
const CADA_S = Number(valor('--cada', '2'));
if (!(CADA_S > 0)) {
  console.error('--cada debe ser un número de segundos mayor que 0');
  process.exit(1);
}

const api = crearClienteApi(URL);
const unaCompra = escenarioNormal(api);
const resultados = [];
const cuenta = { exitosas: 0, rechazadas: 0, ocupadas: 0, errores: 0, sinRespuesta: 0 };

const hora = () => new Date().toLocaleTimeString('es-MX', { hour12: false });
const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const amarillo = (t) => `\x1b[33m${t}\x1b[0m`;
const rojo = (t) => `\x1b[31m${t}\x1b[0m`;

function mostrar(n, r) {
  const ms = r.ms ? `${Math.round(r.ms)} ms` : '';
  const asientos = r.asientos ? `sede ${r.sede_id}, asientos ${r.asientos.join(', ')}` : '';
  if (r.fase === 'consulta') {
    if (r.agotada) return console.log(`${hora()}  #${n}  función agotada, se elige otra`);
    cuenta.errores++;
    return console.log(rojo(`${hora()}  #${n}  no se pudo consultar (${r.status || r.error})`));
  }
  if (r.status === 201) {
    cuenta.exitosas++;
    return console.log(verde(`${hora()}  #${n}  201 compra hecha: orden ${r.orden_id}, ${asientos}  (${ms})`));
  }
  if (r.status === 402) {
    cuenta.rechazadas++;
    return console.log(amarillo(`${hora()}  #${n}  402 pago rechazado (a propósito), ${asientos}  (${ms})`));
  }
  if (r.status === 409) {
    cuenta.ocupadas++;
    return console.log(amarillo(`${hora()}  #${n}  409 asiento ya ocupado, ${asientos}  (${ms})`));
  }
  if (r.status === 0) {
    cuenta.sinRespuesta++;
    return console.log(rojo(`${hora()}  #${n}  la API no respondió (${r.error})`));
  }
  cuenta.errores++;
  return console.log(rojo(`${hora()}  #${n}  ${r.status} error: ${r.error ?? 'sin detalle'}  (${ms})`));
}

function resumen() {
  const { vendidos, repetidos } = revisarDobleVenta(resultados);
  console.log('\nResumen');
  console.log(`  Compras hechas (201)     ${cuenta.exitosas}`);
  console.log(`  Pagos rechazados (402)   ${cuenta.rechazadas}`);
  console.log(`  Asiento ocupado (409)    ${cuenta.ocupadas}`);
  console.log(`  Errores del sistema      ${cuenta.errores}`);
  console.log(`  Sin respuesta de la API  ${cuenta.sinRespuesta}`);
  console.log(`  Asientos vendidos        ${vendidos}`);
  console.log(`  Doble venta              ${repetidos.length}${repetidos.length ? ` ${JSON.stringify(repetidos)}` : ''}`);
  process.exit(repetidos.length ? 1 : 0);
}
process.on('SIGINT', resumen);

console.log(`Una compra cada ${CADA_S} s contra ${URL}. Ctrl+C para terminar y ver el resumen.\n`);
for (let n = 1; ; n++) {
  const inicio = Date.now();
  let r;
  try {
    r = await unaCompra();
  } catch (e) {
    r = { fase: 'compra', status: 0, error: e.message };
  }
  resultados.push(r);
  mostrar(n, r);
  await new Promise((listo) => setTimeout(listo, Math.max(0, CADA_S * 1000 - (Date.now() - inicio))));
}
