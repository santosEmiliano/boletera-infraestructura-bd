// Lanza `concurrencia` compradores en paralelo. Cada uno repite unaCompra()
// hasta llegar al total de compras o hasta que se acabe la duración.
// Cada resultado guarda cuándo empezó (ms desde el arranque), para la línea de
// tiempo del reporte.
const ESPERA_SI_NO_RESPONDE_MS = 200;

export async function correr({ compras, concurrencia, duracion }, unaCompra) {
  const resultados = [];
  const t0 = performance.now();
  const fin = duracion ? t0 + duracion * 1000 : null;
  let lanzadas = 0;

  const quedan = () => (fin ? performance.now() < fin : lanzadas < compras);

  async function comprador() {
    while (quedan()) {
      lanzadas++;
      const inicio = performance.now() - t0;
      const r = await unaCompra();
      resultados.push({ ...r, inicio });
      // Si la API no respondió, el error llega en milisegundos: sin esta pausa
      // cada comprador haría miles de intentos por segundo mientras está caída.
      if (r.status === 0) await new Promise((listo) => setTimeout(listo, ESPERA_SI_NO_RESPONDE_MS));
    }
  }

  // Avance en la misma línea, solo si la salida es una terminal
  const avance = process.stdout.isTTY
    ? setInterval(() => process.stdout.write(`\r  ${resultados.length} compras terminadas...`), 1000)
    : null;
  try {
    await Promise.all(Array.from({ length: concurrencia }, comprador));
  } finally {
    if (avance) {
      clearInterval(avance);
      process.stdout.write('\r\x1b[K');
    }
  }
  return { resultados, duracionMs: performance.now() - t0 };
}
