// Cada escenario devuelve una función que hace una compra completa y regresa:
//   { fase: 'consulta', status, error }   si falló un GET antes de comprar
//   { fase: 'compra', status, ms, error, sede_id, asientos, boletos }
// Solo usa los endpoints de docs/api-contrato.md, así que funciona igual
// contra los stubs que contra la API conectada a las bases.

const METODOS = ['tarjeta', 'transferencia', 'efectivo'];
const CLIENTES = 8000;
// Solo los eventos 1 a 40 tienen función (una por evento; ver los seeds)
const EVENTOS_CON_FUNCION = 40;

const azar = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const elegir = (lista) => lista[Math.floor(Math.random() * lista.length)];
const eventoId = (n) => n.toString(16).padStart(24, '0');

// k elementos distintos al azar
function tomar(lista, k) {
  const copia = [...lista];
  for (let i = 0; i < k; i++) {
    const j = azar(i, copia.length - 1);
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, k);
}

async function comprar(api, { eventoId: evento, funcion, sedeId, asientos }) {
  const r = await api.post('/api/compras', {
    cliente_id: azar(1, CLIENTES),
    evento_id: evento,
    funcion_id: funcion,
    sede_id: sedeId,
    asientos,
    metodo_pago: elegir(METODOS),
  });
  return { fase: 'compra', status: r.status, ms: r.ms, error: r.error, sede_id: sedeId, asientos, boletos: r.json?.boletos };
}

// Normal: un comprador elige evento, función y de 1 a 4 asientos libres, como
// lo haría alguien en la página.
export function escenarioNormal(api) {
  return async () => {
    const evento = eventoId(azar(1, EVENTOS_CON_FUNCION));
    const f = await api.get(`/api/funciones?evento_id=${evento}`);
    if (f.status !== 200 || !f.json?.length) return { fase: 'consulta', status: f.status, error: f.error };
    const funcion = elegir(f.json);

    const a = await api.get(`/api/funciones/${funcion.funcion_id}/asientos?sede_id=${funcion.sede_id}`);
    if (a.status !== 200 || !a.json?.length) return { fase: 'consulta', status: a.status, error: a.error };
    const asientos = tomar(a.json, azar(1, Math.min(4, a.json.length))).map((x) => x.asiento_id);

    return comprar(api, { eventoId: evento, funcion: funcion.funcion_id, sedeId: funcion.sede_id, asientos });
  };
}
