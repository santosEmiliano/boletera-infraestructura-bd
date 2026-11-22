import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { revisarDobleVenta } from './escenarios.js';

// Percentil por rango más cercano: el valor que deja por debajo al p % de las muestras
function percentil(ordenados, p) {
  if (!ordenados.length) return null;
  return ordenados[Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1)];
}

const redondear = (n) => (n === null ? null : Math.round(n * 10) / 10);

// Cuántas compras salieron bien y cuántas fallaron en cada segundo. Con ella se
// mide cuánto duró una caída: los segundos seguidos sin ninguna compra exitosa.
function lineaDeTiempo(resultados) {
  const segundos = [];
  for (const r of resultados) {
    const s = Math.floor(r.inicio / 1000);
    segundos[s] ??= { segundo: s, exitosas: 0, rechazadas: 0, errores: 0 };
    const fila = segundos[s];
    if (r.fase === 'compra' && r.status === 201) fila.exitosas++;
    else if (r.fase === 'compra' && (r.status === 409 || r.status === 402)) fila.rechazadas++;
    else fila.errores++;
  }
  return Array.from(segundos, (fila, s) => fila ?? { segundo: s, exitosas: 0, rechazadas: 0, errores: 0 });
}

function caidaMasLarga(linea) {
  let mayor = { segundos: 0, desde: null };
  let actual = 0;
  linea.forEach((fila, i) => {
    actual = fila.errores > 0 && fila.exitosas === 0 ? actual + 1 : 0;
    if (actual > mayor.segundos) mayor = { segundos: actual, desde: i - actual + 1 };
  });
  return mayor;
}

export function resumir(resultados, duracionMs, parametros) {
  const compras = resultados.filter((r) => r.fase === 'compra');
  const cuenta = (filtro) => compras.filter(filtro).length;
  const latencias = compras.filter((r) => r.status !== 0).map((r) => r.ms).sort((a, b) => a - b);
  const segundos = duracionMs / 1000;
  const linea = lineaDeTiempo(resultados);

  return {
    fecha: new Date().toISOString(),
    parametros,
    totales: {
      intentos: resultados.length,
      compras: compras.length,
      exitosas: cuenta((r) => r.status === 201),
      asiento_no_disponible: cuenta((r) => r.status === 409),
      pago_rechazado: cuenta((r) => r.status === 402),
      otros_4xx: cuenta((r) => r.status >= 400 && r.status < 500 && r.status !== 409 && r.status !== 402),
      errores_5xx: cuenta((r) => r.status >= 500),
      sin_respuesta: cuenta((r) => r.status === 0),
      fallas_al_consultar: resultados.length - compras.length,
    },
    duracion_s: redondear(segundos),
    tps: redondear(compras.length / segundos),
    tps_exitosas: redondear(cuenta((r) => r.status === 201) / segundos),
    latencia_ms: {
      p50: redondear(percentil(latencias, 50)),
      p95: redondear(percentil(latencias, 95)),
      p99: redondear(percentil(latencias, 99)),
      max: redondear(latencias.at(-1) ?? null),
    },
    doble_venta: revisarDobleVenta(resultados),
    caida_mas_larga: caidaMasLarga(linea),
    linea_de_tiempo: linea,
  };
}

export function imprimir(r) {
  const t = r.totales;
  const l = r.latencia_ms;
  const fila = (etiqueta, valor) => console.log(`${etiqueta.padEnd(24)}${valor}`);
  const repetidos = r.doble_venta.repetidos.length;

  console.log('');
  fila('Compras', `${t.compras}  (intentos: ${t.intentos})`);
  fila('  201 exitosas', t.exitosas);
  fila('  409 no disponible', t.asiento_no_disponible);
  fila('  402 pago rechazado', t.pago_rechazado);
  fila('  otros 4xx', t.otros_4xx);
  fila('  5xx', t.errores_5xx);
  fila('  sin respuesta', t.sin_respuesta);
  fila('Fallas al consultar', t.fallas_al_consultar);
  console.log('');
  fila('Duración', `${r.duracion_s} s`);
  fila('TPS', `${r.tps}  (exitosas: ${r.tps_exitosas}/s)`);
  fila('Latencia (ms)', `p50 ${l.p50}   p95 ${l.p95}   p99 ${l.p99}   máx ${l.max}`);
  console.log('');
  fila('Asientos vendidos', r.doble_venta.vendidos);
  fila('Doble venta', repetidos ? `${repetidos}  ¡REVISAR!` : 0);
  if (r.caida_mas_larga.segundos > 0) {
    fila('Caída más larga', `${r.caida_mas_larga.segundos} s sin compras exitosas, desde el segundo ${r.caida_mas_larga.desde}`);
  }
}

export async function guardar(r, carpeta) {
  await mkdir(carpeta, { recursive: true });
  const archivo = join(carpeta, `${r.fecha.replaceAll(':', '-').slice(0, 19)}-${r.parametros.escenario}.json`);
  await writeFile(archivo, JSON.stringify(r, null, 2));
  return archivo;
}
