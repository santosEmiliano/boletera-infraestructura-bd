import { MongoClient, ObjectId } from 'mongodb';
import mysql from 'mysql2/promise';
import { fakerES_MX as faker } from '@faker-js/faker';

// Forma de cada colección: mongo/seed/modelo.md
const EVENTOS = 600;
const FUNCIONES = 40;
const CLIENTES = 8000;
const RESENAS = 15000;
const ACTIVIDAD_TOTAL = 25000;
const BITACORA_TOTAL = 3000;
const NOTIFICACIONES_TOTAL = 12000;
const LOTE = 1000;

const CATEGORIAS = ['concierto', 'teatro', 'deportes', 'festival'];
const ZONAS = [2500, 2000, 1800, 1500, 1200, 1000, 850, 700, 500, 400];

// Acuerdo con los otros seeds (mysql/seed/README.md)
const eventoHex = (n) => n.toString(16).padStart(24, '0');
const eventoOid = (n) => new ObjectId(eventoHex(n));
const sedeDe = (f) => Math.ceil(f / 10);
const asientoId = (f, pos) => ((f - 1) % 10) * 1000 + pos + 1;

const GENEROS = ['rock', 'pop', 'jazz', 'banda', 'electrónica', 'reguetón', 'clásica'];
const LIGAS = ['Liga MX', 'LMB', 'LNBP', 'Liga MX Femenil'];
const CLASIFICACIONES = ['A', 'B', 'B15', 'C'];
const PUERTAS = ['A', 'B', 'C', 'D'];

function detalle(categoria) {
  switch (categoria) {
    case 'concierto':
      return {
        artistas: faker.helpers.multiple(() => faker.music.artist(), { count: { min: 1, max: 4 } }),
        genero: faker.helpers.arrayElement(GENEROS),
      };
    case 'teatro':
      return {
        compania: `Compañía ${faker.person.lastName()}`,
        director: faker.person.fullName(),
        elenco: faker.helpers.multiple(() => faker.person.fullName(), { count: { min: 3, max: 6 } }),
      };
    case 'deportes':
      return { liga: faker.helpers.arrayElement(LIGAS), local: faker.location.city(), visitante: faker.location.city() };
    default:
      return {
        dias: faker.number.int({ min: 1, max: 3 }),
        escenarios: faker.helpers.multiple(() => ({
          nombre: `Escenario ${faker.word.adjective()}`,
          artistas: faker.helpers.multiple(() => faker.music.artist(), { count: { min: 2, max: 5 } }),
        }), { count: { min: 2, max: 4 } }),
      };
  }
}

function nombreDe(categoria) {
  switch (categoria) {
    case 'concierto': return `${faker.music.artist()} en vivo`;
    case 'teatro': return faker.music.songName();
    case 'deportes': return `${faker.location.city()} vs ${faker.location.city()}`;
    default: return `Festival ${faker.word.adjective()} ${faker.date.month()}`;
  }
}

function eventos(desde) {
  const docs = [];
  for (let n = 1; n <= EVENTOS; n++) {
    const categoria = CATEGORIAS[n % 4];
    docs.push({
      _id: eventoOid(n),
      nombre: nombreDe(categoria),
      categoria,
      descripcion: faker.lorem.sentence({ min: 8, max: 16 }),
      duracion_min: faker.number.int({ min: 60, max: 240 }),
      clasificacion: faker.helpers.arrayElement(CLASIFICACIONES),
      etiquetas: faker.helpers.arrayElements([categoria, 'en vivo', 'familiar', 'nocturno', 'estreno'], { min: 1, max: 3 }),
      detalle: detalle(categoria),
      creado_en: faker.date.between({ from: desde, to: new Date() }),
    });
  }
  return docs;
}

function resenas(desde) {
  const docs = [];
  for (let i = 0; i < RESENAS; i++) {
    docs.push({
      cliente_id: faker.number.int({ min: 1, max: CLIENTES }),
      // Las 40 con función tienen más reseñas
      evento_id: eventoOid(faker.number.int({ min: 1, max: faker.datatype.boolean(0.6) ? FUNCIONES : EVENTOS })),
      calificacion: faker.helpers.weightedArrayElement([
        { weight: 5, value: 1 }, { weight: 8, value: 2 }, { weight: 20, value: 3 }, { weight: 35, value: 4 }, { weight: 32, value: 5 },
      ]),
      comentario: faker.datatype.boolean(0.7) ? faker.lorem.sentence({ min: 4, max: 14 }) : null,
      creada_en: faker.date.between({ from: desde, to: new Date() }),
    });
  }
  return docs;
}

function asientosAlAzar(funcion) {
  const posiciones = faker.helpers.arrayElements([...Array(1000).keys()], { min: 1, max: 4 });
  return {
    asientos: posiciones.map((p) => asientoId(funcion, p)),
    total: posiciones.reduce((s, p) => s + ZONAS[Math.floor(p / 100)], 0),
  };
}

function actividad(ordenes, desde) {
  const docs = [];
  for (const o of ordenes) {
    if (o.estado !== 'pagada') continue;
    docs.push({ cliente_id: o.cliente_id, tipo: 'compra', evento_id: new ObjectId(o.evento_id), orden_id: o.orden_id, fecha: o.pagado_en });
  }
  while (docs.length < ACTIVIDAD_TOTAL) {
    const tipo = faker.helpers.weightedArrayElement([
      { weight: 60, value: 'vio_evento' }, { weight: 25, value: 'eligio_asientos' }, { weight: 15, value: 'abandono_carrito' },
    ]);
    const cliente_id = faker.number.int({ min: 1, max: CLIENTES });
    const fecha = faker.date.between({ from: desde, to: new Date() });
    if (tipo === 'vio_evento') {
      const n = faker.number.int({ min: 1, max: EVENTOS });
      docs.push({ cliente_id, tipo, evento_id: eventoOid(n), fecha, detalle: { origen: faker.helpers.arrayElement(['cartelera', 'busqueda']) } });
      continue;
    }
    const funcion = faker.number.int({ min: 1, max: FUNCIONES });
    const { asientos, total } = asientosAlAzar(funcion);
    const base = { funcion_id: funcion, sede_id: sedeDe(funcion), asientos };
    docs.push({ cliente_id, tipo, evento_id: eventoOid(funcion), fecha, detalle: tipo === 'abandono_carrito' ? { ...base, total } : base });
  }
  return docs;
}

const despues = (fecha, diasMax) => new Date(fecha.getTime() + faker.number.int({ min: 1, max: diasMax * 24 * 60 }) * 60000);

function bitacora(boletos) {
  const docs = [];
  const usados = boletos.filter((b) => b.estado === 'usado');
  const anulados = boletos.filter((b) => b.estado === 'anulado');
  for (const b of usados) {
    docs.push({ codigo_qr: b.codigo_qr, puerta: faker.helpers.arrayElement(PUERTAS), resultado: 'valido', boleto_id: b.boleto_id, fecha: despues(b.emitido_en, 30) });
  }
  for (const b of anulados) {
    docs.push({ codigo_qr: b.codigo_qr, puerta: faker.helpers.arrayElement(PUERTAS), resultado: 'no_valido', boleto_id: b.boleto_id, fecha: despues(b.emitido_en, 30) });
  }
  // Reescaneos de boletos ya usados, después de su acceso válido
  const validos = docs.filter((d) => d.resultado === 'valido');
  const reescaneos = Math.round((BITACORA_TOTAL - docs.length) * 0.8);
  for (const v of faker.helpers.arrayElements(validos, Math.min(reescaneos, validos.length))) {
    docs.push({ codigo_qr: v.codigo_qr, puerta: faker.helpers.arrayElement(PUERTAS), resultado: 'no_valido', boleto_id: v.boleto_id, fecha: new Date(v.fecha.getTime() + faker.number.int({ min: 1, max: 180 }) * 60000) });
  }
  while (docs.length < BITACORA_TOTAL) {
    docs.push({
      codigo_qr: faker.string.hexadecimal({ length: 32, prefix: '', casing: 'lower' }),
      puerta: faker.helpers.arrayElement(PUERTAS),
      resultado: 'no_existe',
      boleto_id: null,
      fecha: faker.date.recent({ days: 60 }),
    });
  }
  return docs;
}

const MENSAJES = {
  confirmacion: (o) => `Tu compra ${o.orden_id} está confirmada`,
  cancelacion: (o) => `Tu compra ${o.orden_id} se canceló: el pago fue rechazado`,
  expiracion: (o) => `Tu reserva de la orden ${o.orden_id} venció sin pago`,
  recordatorio: (o) => `Recuerda: tu evento de la orden ${o.orden_id} es pronto`,
};
const TIPO_POR_ESTADO = { pagada: 'confirmacion', cancelada: 'cancelacion', expirada: 'expiracion' };

function notificaciones(ordenes) {
  const docs = [];
  const nota = (o, tipo, creada_en) => ({
    cliente_id: o.cliente_id, tipo, orden_id: o.orden_id, mensaje: MENSAJES[tipo](o), leida: faker.datatype.boolean(0.6), creada_en,
  });
  for (const o of ordenes) {
    const tipo = TIPO_POR_ESTADO[o.estado];
    if (tipo) docs.push(nota(o, tipo, new Date((o.pagado_en ?? o.creada_en).getTime() + 60000)));
  }
  const pagadas = ordenes.filter((o) => o.estado === 'pagada');
  for (const o of faker.helpers.arrayElements(pagadas, Math.max(0, Math.min(NOTIFICACIONES_TOTAL - docs.length, pagadas.length)))) {
    docs.push(nota(o, 'recordatorio', despues(o.pagado_en, 20)));
  }
  return docs;
}

async function leerMysql() {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE ?? 'boletera',
  });
  const [ordenes] = await db.query(
    `SELECT o.orden_id, o.cliente_id, o.evento_id, o.estado, o.creada_en, MAX(p.pagado_en) AS pagado_en
       FROM ordenes o LEFT JOIN pagos p ON p.orden_id = o.orden_id AND p.estado = 'aprobado'
      GROUP BY o.orden_id ORDER BY o.orden_id`,
  );
  const [boletos] = await db.query('SELECT boleto_id, codigo_qr, estado, emitido_en FROM boletos ORDER BY boleto_id');
  await db.end();
  // Una orden pagada sin fecha de pago no debería existir; por si acaso, su fecha de creación
  for (const o of ordenes) if (o.estado === 'pagada' && !o.pagado_en) o.pagado_en = o.creada_en;
  return { ordenes, boletos };
}

async function insertar(coleccion, docs) {
  for (let i = 0; i < docs.length; i += LOTE) {
    await coleccion.insertMany(docs.slice(i, i + LOTE), { ordered: false });
  }
}

async function main() {
  if (!process.env.MYSQL_PASSWORD) {
    console.error('Falta MYSQL_PASSWORD (el seed lee las órdenes y boletos de MySQL)');
    process.exit(1);
  }
  const cliente = new MongoClient(process.env.MONGO_URI ?? 'mongodb://localhost:27017/boletera');
  await cliente.connect();
  const db = cliente.db();

  // Por mongos los documentos se reparten entre los shards; directo a un mongod no
  if ((await db.admin().command({ hello: 1 })).msg !== 'isdbgrid' && !process.argv.includes('--sin-mongos')) {
    console.error('MONGO_URI no apunta a un mongos. El seed va por mongos, después de 04_configurar_sharding.js.');
    console.error('Para probar contra un MongoDB suelto: --sin-mongos');
    await cliente.close();
    process.exit(1);
  }

  const nombres = ['eventos', 'resenas', 'actividad_usuarios', 'bitacora_accesos', 'notificaciones'];
  const hayDatos = (await Promise.all(nombres.map((n) => db.collection(n).estimatedDocumentCount()))).some((c) => c > 0);
  if (hayDatos) {
    if (!process.argv.includes('--reiniciar')) {
      console.error('La base ya tiene datos. Usa --reiniciar para borrarlos y volver a cargar.');
      await cliente.close();
      process.exit(1);
    }
    // deleteMany y no drop: borrar la colección perdería su fragmentación y sus índices
    for (const n of nombres) await db.collection(n).deleteMany({});
  }

  const { ordenes, boletos } = await leerMysql();
  faker.seed(2026);
  const hace1Anio = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const datos = {
    eventos: eventos(hace1Anio),
    resenas: resenas(hace1Anio),
    actividad_usuarios: actividad(ordenes, hace1Anio),
    bitacora_accesos: bitacora(boletos),
    notificaciones: notificaciones(ordenes),
  };

  let total = 0;
  for (const n of nombres) {
    await insertar(db.collection(n), datos[n]);
    const c = await db.collection(n).countDocuments();
    console.log(n.padEnd(20), c);
    total += c;
  }
  console.log('total'.padEnd(20), total);
  await cliente.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
