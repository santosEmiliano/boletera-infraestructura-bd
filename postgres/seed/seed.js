import pg from 'pg';
import { fakerES_MX as faker } from '@faker-js/faker';

const SEDES = 4;
const FUNCIONES = 40;
const ASIENTOS_POR_FUNCION = 1000;
const ASIENTOS_POR_ZONA = 100;
const ASIENTOS_POR_FILA = 25;
const LOTE = 1000;

// Acuerdo con el seed de MySQL (mysql/seed/README.md): la función f va en la
// sede ceil(f/10), es el evento f y usa los 1000 asientos que empiezan en
// ((f-1) % 10) * 1000 + 1 dentro de su sede.
const sedeDe = (f) => Math.ceil(f / 10);
const eventoId = (n) => n.toString(16).padStart(24, '0');
const asientoId = (f, pos) => ((f - 1) % 10) * ASIENTOS_POR_FUNCION + pos + 1;

// 10 zonas por sede, en bloques de 100 asientos según la posición dentro de la
// función (docs/arquitectura.md, sección 3.4).
const ZONAS = [
  { nombre: 'VIP Pista', precio: 2500 },
  { nombre: 'VIP Lateral', precio: 2000 },
  { nombre: 'Platino', precio: 1800 },
  { nombre: 'Oro', precio: 1500 },
  { nombre: 'Preferente A', precio: 1200 },
  { nombre: 'Preferente B', precio: 1000 },
  { nombre: 'General A', precio: 850 },
  { nombre: 'General B', precio: 700 },
  { nombre: 'Balcón A', precio: 500 },
  { nombre: 'Balcón B', precio: 400 },
];
const zonaId = (sede, pos) => (sede - 1) * ZONAS.length + Math.floor(pos / ASIENTOS_POR_ZONA) + 1;

// 40 filas de 25 asientos por función: A a Z y luego AA a AN.
function fila(pos) {
  const i = Math.floor(pos / ASIENTOS_POR_FILA);
  return i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26);
}

// Inserta por lotes de 1000 filas con parámetros ($1, $2, ...), nunca
// concatenando valores en el SQL.
async function insertar(db, tabla, columnas, filas) {
  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE);
    const valores = [];
    const renglones = lote.map((fila) => {
      const marcas = fila.map((v) => {
        valores.push(v);
        return `$${valores.length}`;
      });
      return `(${marcas.join(', ')})`;
    });
    await db.query(`INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES ${renglones.join(', ')}`, valores);
  }
}

function generarCatalogo() {
  const zonas = [];
  for (let sede = 1; sede <= SEDES; sede++) {
    ZONAS.forEach((z, i) => zonas.push([(sede - 1) * ZONAS.length + i + 1, sede, z.nombre, z.precio]));
  }

  // Funciones en los próximos 6 meses, a las 17:00, 18:00, 19:00, 20:00 o 21:00.
  const ahora = new Date();
  const en6Meses = new Date(ahora.getFullYear(), ahora.getMonth() + 6, ahora.getDate());
  const funciones = [];
  for (let f = 1; f <= FUNCIONES; f++) {
    const fecha = faker.date.between({ from: ahora, to: en6Meses });
    fecha.setHours(faker.number.int({ min: 17, max: 21 }), 0, 0, 0);
    funciones.push([f, eventoId(f), sedeDe(f), fecha]);
  }

  const asientos = [];
  for (let f = 1; f <= FUNCIONES; f++) {
    const sede = sedeDe(f);
    for (let pos = 0; pos < ASIENTOS_POR_FUNCION; pos++) {
      asientos.push([asientoId(f, pos), sede, f, zonaId(sede, pos), fila(pos), (pos % ASIENTOS_POR_FILA) + 1]);
    }
  }

  return { zonas, funciones, asientos };
}

async function main() {
  if (!process.env.PGPASSWORD) {
    console.error('Falta PGPASSWORD');
    process.exit(1);
  }
  const db = new pg.Client({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? 'boletera',
  });
  await db.connect();

  faker.seed(2026);
  const c = generarCatalogo();

  // Todo en una transacción: si algo falla, no queda nada cargado a medias.
  try {
    await db.query('BEGIN');
    await insertar(db, 'zonas', ['zona_id', 'sede_id', 'nombre', 'precio_base'], c.zonas);
    await insertar(db, 'funciones', ['funcion_id', 'evento_id', 'sede_id', 'fecha_hora'], c.funciones);
    await insertar(db, 'asientos', ['asiento_id', 'sede_id', 'funcion_id', 'zona_id', 'fila', 'numero'], c.asientos);

    // Los ids se insertaron a mano: la secuencia sigue después del último.
    await db.query("SELECT setval(pg_get_serial_sequence('zonas', 'zona_id'), (SELECT max(zona_id) FROM zonas))");
    await db.query("SELECT setval(pg_get_serial_sequence('funciones', 'funcion_id'), (SELECT max(funcion_id) FROM funciones))");
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }

  console.log(`zonas ${c.zonas.length}, funciones ${c.funciones.length}, asientos ${c.asientos.length}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
