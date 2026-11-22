// Cliente HTTP de la API. Nunca lanza errores: siempre devuelve
// { status, json, ms }. status 0 es que no hubo respuesta (error de red o timeout).
const TIMEOUT_MS = 10_000;

export function crearClienteApi(url) {
  async function pedir(metodo, ruta, cuerpo) {
    const inicio = performance.now();
    try {
      const res = await fetch(url + ruta, {
        method: metodo,
        headers: cuerpo ? { 'content-type': 'application/json' } : undefined,
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json, ms: performance.now() - inicio };
    } catch (e) {
      const error = e.name === 'TimeoutError' ? 'timeout' : 'red';
      return { status: 0, error, ms: performance.now() - inicio };
    }
  }

  return {
    get: (ruta) => pedir('GET', ruta),
    post: (ruta, cuerpo) => pedir('POST', ruta, cuerpo),
  };
}
