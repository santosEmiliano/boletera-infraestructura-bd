// Cada escenario devuelve una función que hace una compra completa y regresa:
//   { fase: 'consulta', status, error }   si falló un GET antes de comprar
//   { fase: 'consulta', agotada: true }   si la función ya no tiene asientos libres
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
  return {
    fase: 'compra', status: r.status, ms: r.ms, error: r.error ?? r.json?.error, sede_id: sedeId, asientos,
    boletos: r.json?.boletos, orden_id: r.json?.orden_id,
  };
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
    if (a.status !== 200) return { fase: 'consulta', status: a.status, error: a.error };
    // Función sin asientos libres: no es un error de la API, la función se llenó
    if (!a.json?.length) return { fase: 'consulta', status: 200, agotada: true };
    const asientos = tomar(a.json, azar(1, Math.min(4, a.json.length))).map((x) => x.asiento_id);

    return comprar(api, { eventoId: evento, funcion: funcion.funcion_id, sedeId: funcion.sede_id, asientos });
  };
}

// Preventa: todos los compradores quieren un asiento de los mismos pocos de una
// función. Sirve para probar que ningún asiento se vende dos veces: con N
// asientos en disputa, como máximo N compras pueden salir bien.
// Antes de empezar busca la función y aparta la lista de asientos en disputa;
// si la API no responde, lanza un error y no se corre nada.
export async function prepararPreventa(api, { funcion, asientos: cuantos }) {
  // La función f es del evento f (regla de los seeds)
  const evento = eventoId(funcion);
  const f = await api.get(`/api/funciones?evento_id=${evento}`);
  const datos = f.status === 200 && f.json?.find((x) => x.funcion_id === funcion);
  if (!datos) throw new Error(`No se encontró la función ${funcion} (GET /api/funciones respondió ${f.status || f.error})`);

  const a = await api.get(`/api/funciones/${funcion}/asientos?sede_id=${datos.sede_id}`);
  if (a.status !== 200) throw new Error(`No se pudieron leer los asientos de la función ${funcion} (${a.status || a.error})`);
  if (a.json.length < cuantos) throw new Error(`La función ${funcion} solo tiene ${a.json.length} asientos libres`);
  const disputados = a.json.slice(0, cuantos).map((x) => x.asiento_id);

  const unaCompra = () => comprar(api, { eventoId: evento, funcion, sedeId: datos.sede_id, asientos: [elegir(disputados)] });
  return { unaCompra, sedeId: datos.sede_id, disputados };
}

// Junta los asientos de todas las compras exitosas (201) y busca repetidos.
// Un repetido sería una doble venta.
export function revisarDobleVenta(resultados) {
  const veces = new Map();
  for (const r of resultados) {
    if (r.fase !== 'compra' || r.status !== 201) continue;
    const asientos = r.boletos?.map((b) => b.asiento_id) ?? r.asientos;
    for (const id of asientos) {
      const clave = `${r.sede_id}:${id}`;
      veces.set(clave, (veces.get(clave) ?? 0) + 1);
    }
  }
  const repetidos = [...veces].filter(([, n]) => n > 1).map(([clave, n]) => ({ asiento: clave, veces: n }));
  return { vendidos: veces.size, repetidos };
}
