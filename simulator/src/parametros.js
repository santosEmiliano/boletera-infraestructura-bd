import { parseArgs } from 'node:util';

// Perfiles del plan: cuántas compras en total y cuántos compradores a la vez
export const PERFILES = {
  decenas: { compras: 50, concurrencia: 10 },
  cientos: { compras: 500, concurrencia: 50 },
  miles: { compras: 5000, concurrencia: 200 },
};

const ESCENARIOS = ['normal', 'preventa'];

export const AYUDA = `Uso: node run.js [opciones]

  --url <url>            API a probar (por defecto http://localhost:4000)
  --perfil <nombre>      decenas, cientos o miles (por defecto decenas)
  --compras <n>          total de compras; reemplaza al del perfil
  --concurrencia <n>     compradores a la vez; reemplaza al del perfil
  --duracion <seg>       compra sin parar durante esos segundos en vez de un total
  --escenario <nombre>   normal o preventa (por defecto normal)
  --funcion <id>         preventa: función que se disputa (por defecto 1)
  --asientos <n>         preventa: cuántos asientos se disputan (por defecto 10)
  --salida <carpeta>     dónde guardar el JSON (por defecto resultados)
  -h, --ayuda            muestra esta ayuda`;

function entero(valor, nombre) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${nombre} debe ser un entero mayor que 0 (llegó "${valor}")`);
  return n;
}

export function leerParametros(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'http://localhost:4000' },
      perfil: { type: 'string', default: 'decenas' },
      compras: { type: 'string' },
      concurrencia: { type: 'string' },
      duracion: { type: 'string' },
      escenario: { type: 'string', default: 'normal' },
      funcion: { type: 'string', default: '1' },
      asientos: { type: 'string', default: '10' },
      salida: { type: 'string', default: 'resultados' },
      ayuda: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.ayuda) return { ayuda: true };

  const perfil = PERFILES[v.perfil];
  if (!perfil) throw new Error(`--perfil debe ser ${Object.keys(PERFILES).join(', ')} (llegó "${v.perfil}")`);
  if (!ESCENARIOS.includes(v.escenario)) throw new Error(`--escenario debe ser ${ESCENARIOS.join(' o ')} (llegó "${v.escenario}")`);

  const duracion = v.duracion === undefined ? null : entero(v.duracion, 'duracion');
  return {
    url: v.url.replace(/\/+$/, ''),
    perfil: v.perfil,
    escenario: v.escenario,
    // Con --duracion no hay total: se compra hasta que se acabe el tiempo
    compras: duracion ? null : (v.compras === undefined ? perfil.compras : entero(v.compras, 'compras')),
    concurrencia: v.concurrencia === undefined ? perfil.concurrencia : entero(v.concurrencia, 'concurrencia'),
    duracion,
    funcion: entero(v.funcion, 'funcion'),
    asientos: entero(v.asientos, 'asientos'),
    salida: v.salida,
  };
}
