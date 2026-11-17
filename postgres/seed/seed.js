import pg from 'pg';
import mysql from 'mysql2/promise';
import { fakerES_MX as faker } from '@faker-js/faker';

const SEDES = 4;
const FUNCIONES = 40;
const ASIENTOS_POR_FUNCION = 1000;
const ASIENTOS_POR_ZONA = 100;
const ASIENTOS_POR_FILA = 25;
const MINUTOS_RESERVA = 10;
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

// Qué le pasa en PostgreSQL a cada asiento según el estado de su orden en MySQL.
//   asiento:     estado final del asiento
//   reserva:     estado de la reserva
//   cierre:      movimiento que sigue a la reserva (null si la orden sigue pendiente)
const POR_ESTADO = {
  pagada: { asiento: 'vendido', reserva: 'confirmada', cierre: 'venta' },
  cancelada: { asiento: 'libre', reserva: 'cancelada', cierre: 'liberacion' },
  expirada: { asiento: 'libre', reserva: 'expirada', cierre: 'liberacion' },
  pendiente: { asiento: 'reservado', reserva: 'activa', cierre: null },
};

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

// Un renglón por asiento vendido, cancelado, expirado o pendiente en MySQL, con
// el estado de su orden y la fecha de su pago (si lo hubo).
async function leerOrdenes() {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE ?? 'boletera',
  });
  try {
    const [filas] = await db.query(`
      SELECT d.orden_id, d.sede_id, d.asiento_id, o.estado, o.creada_en, p.pagado_en
      FROM orden_detalle d
      JOIN ordenes o ON o.orden_id = d.orden_id
      LEFT JOIN (SELECT orden_id, MAX(pagado_en) AS pagado_en FROM pagos GROUP BY orden_id) p
        ON p.orden_id = d.orden_id
      ORDER BY d.orden_id, d.detalle_id`);
    return filas;
  } finally {
    await db.end();
  }
}

// Traduce las órdenes de MySQL a estados de asientos, reservas y movimientos.
function generarInventario(ordenes) {
  const cambios = {}; // cambios[estado][sede] = [asiento_id, ...]
  const reservas = [];
  const movimientos = [];

  for (const o of ordenes) {
    const regla = POR_ESTADO[o.estado];
    const creada = new Date(o.creada_en);
    const expira = new Date(creada.getTime() + MINUTOS_RESERVA * 60000);

    if (regla.asiento !== 'libre') {
      cambios[regla.asiento] ??= {};
      (cambios[regla.asiento][o.sede_id] ??= []).push(o.asiento_id);
    }

    reservas.push([o.sede_id, o.asiento_id, o.orden_id, expira, regla.reserva]);
    movimientos.push([o.sede_id, o.asiento_id, 'reserva', creada]);
    if (regla.cierre) {
      // La venta o liberación ocurre al pagar o rechazar el pago; una orden
      // expirada se libera cuando vence la reserva.
      const cuando = o.pagado_en ? new Date(o.pagado_en) : expira;
      movimientos.push([o.sede_id, o.asiento_id, regla.cierre, cuando]);
    }
  }

  return { cambios, reservas, movimientos };
}

async function main() {
  if (!process.env.PGPASSWORD || !process.env.MYSQL_PASSWORD) {
    console.error('Faltan PGPASSWORD y MYSQL_PASSWORD');
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

  const reiniciar = process.argv.includes('--reiniciar');
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM asientos');
  if (n > 0 && !reiniciar) {
    console.error('La base ya tiene datos. Usa --reiniciar para borrarlos y volver a cargar.');
    await db.end();
    process.exit(1);
  }

  faker.seed(2026);
  const c = generarCatalogo();
  const ordenes = await leerOrdenes();
  const inv = generarInventario(ordenes);

  // Todo en una transacción: si algo falla, no queda nada cargado a medias. El
  // TRUNCATE también entra en la transacción, así que si la carga falla, los
  // datos anteriores vuelven.
  try {
    await db.query('BEGIN');
    if (reiniciar) {
      // sedes no se borra: la carga el esquema, no el seed.
      await db.query('TRUNCATE movimientos_inventario, reservas_asiento, asientos, funciones, zonas RESTART IDENTITY');
    }
    await insertar(db, 'zonas', ['zona_id', 'sede_id', 'nombre', 'precio_base'], c.zonas);
    await insertar(db, 'funciones', ['funcion_id', 'evento_id', 'sede_id', 'fecha_hora'], c.funciones);
    await insertar(db, 'asientos', ['asiento_id', 'sede_id', 'funcion_id', 'zona_id', 'fila', 'numero'], c.asientos);

    // Un UPDATE por estado y sede, siempre con sede_id para tocar una sola partición.
    for (const [estado, porSede] of Object.entries(inv.cambios)) {
      for (const [sede, ids] of Object.entries(porSede)) {
        await db.query('UPDATE asientos SET estado = $1 WHERE sede_id = $2 AND asiento_id = ANY($3)', [estado, sede, ids]);
      }
    }
    await insertar(db, 'reservas_asiento', ['sede_id', 'asiento_id', 'orden_id', 'expira_en', 'estado'], inv.reservas);
    await insertar(db, 'movimientos_inventario', ['sede_id', 'asiento_id', 'tipo', 'creado_en'], inv.movimientos);

    // Los ids de zonas y funciones se insertaron a mano: la secuencia sigue después del último.
    await db.query("SELECT setval(pg_get_serial_sequence('zonas', 'zona_id'), (SELECT max(zona_id) FROM zonas))");
    await db.query("SELECT setval(pg_get_serial_sequence('funciones', 'funcion_id'), (SELECT max(funcion_id) FROM funciones))");
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    await db.end();
    throw e;
  }

  console.log('asientos en ordenes de MySQL'.padEnd(30), ordenes.length);
  let total = 0;
  for (const t of ['sedes', 'zonas', 'funciones', 'asientos', 'reservas_asiento', 'movimientos_inventario']) {
    const { rows: [{ filas }] } = await db.query(`SELECT count(*)::int AS filas FROM ${t}`);
    console.log(t.padEnd(30), filas);
    total += filas;
  }
  console.log('total'.padEnd(30), total);
  await db.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
