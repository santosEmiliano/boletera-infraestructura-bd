import mysql from 'mysql2/promise';
import { fakerES_MX as faker } from '@faker-js/faker';

const CLIENTES = 8000;
const ORDENES = 12000;
const FUNCIONES = 40;
const ASIENTOS_POR_FUNCION = 1000;

// Acuerdo con los otros seeds: la función f va en la sede ceil(f/10), es el evento f
// y sus asientos son los 1000 que empiezan en ((f-1) % 10) * 1000 + 1 dentro de la sede.
const sedeDe = (f) => Math.ceil(f / 10);
const eventoId = (n) => n.toString(16).padStart(24, '0');
const asientoId = (f, pos) => ((f - 1) % 10) * ASIENTOS_POR_FUNCION + pos + 1;

const ZONAS = [
  { nombre: 'VIP', hasta: 100, precio: 1800 },
  { nombre: 'Preferente', hasta: 350, precio: 1200 },
  { nombre: 'General', hasta: 700, precio: 850 },
  { nombre: 'Balcón', hasta: 1000, precio: 500 },
];
const zonaDe = (pos) => ZONAS.find((z) => pos < z.hasta);

const limpiar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

function rfc() {
  const letras = faker.string.alpha({ length: 4, casing: 'upper' });
  const fecha = faker.string.numeric(6);
  const clave = faker.string.alphanumeric({ length: 3, casing: 'upper' });
  return letras + fecha + clave;
}

async function insertar(db, tabla, columnas, filas) {
  for (let i = 0; i < filas.length; i += 1000) {
    await db.query(`INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES ?`, [filas.slice(i, i + 1000)]);
  }
}

function generar() {
  const ahora = new Date();
  const hace2Anios = new Date(ahora.getFullYear() - 2, ahora.getMonth(), ahora.getDate());

  const contacto = [];
  const facturacion = [];
  const clientes = [];
  for (let id = 1; id <= CLIENTES; id++) {
    const nombre = faker.person.firstName();
    const apellidos = `${faker.person.lastName()} ${faker.person.lastName()}`;
    const creado = faker.date.between({ from: hace2Anios, to: ahora });
    const email = `${limpiar(nombre)}.${limpiar(apellidos.split(' ')[0])}${id}@example.com`;
    const pref = faker.helpers.arrayElement(['tarjeta', 'transferencia', 'efectivo']);
    contacto.push([id, nombre, apellidos, email, faker.phone.number({ style: 'national' }).slice(0, 20), faker.location.city(), creado]);
    const conRfc = faker.number.int({ min: 1, max: 10 }) <= 7;
    facturacion.push([
      id,
      conRfc ? rfc() : null,
      conRfc ? faker.company.name().slice(0, 120) : null,
      conRfc ? faker.location.streetAddress().slice(0, 200) : null,
      pref,
    ]);
    clientes.push({ id, creado, pref });
  }

  const libres = [];
  for (let f = 1; f <= FUNCIONES; f++) {
    libres[f] = faker.helpers.shuffle(Array.from({ length: ASIENTOS_POR_FUNCION }, (_, i) => i));
  }

  const ordenes = [];
  const detalle = [];
  const pagos = [];
  const boletos = [];

  for (let id = 1; id <= ORDENES; id++) {
    const cliente = faker.helpers.arrayElement(clientes);
    const cantidad = faker.helpers.weightedArrayElement([
      { weight: 55, value: 1 },
      { weight: 30, value: 2 },
      { weight: 10, value: 3 },
      { weight: 5, value: 4 },
    ]);
    const candidatas = [];
    for (let f = 1; f <= FUNCIONES; f++) if (libres[f].length >= cantidad) candidatas.push(f);
    const funcion = faker.helpers.arrayElement(candidatas);
    const sede = sedeDe(funcion);

    const estado = faker.helpers.weightedArrayElement([
      { weight: 80, value: 'pagada' },
      { weight: 10, value: 'cancelada' },
      { weight: 5, value: 'expirada' },
      { weight: 5, value: 'pendiente' },
    ]);
    const creada = faker.date.between({ from: cliente.creado, to: ahora });

    let total = 0;
    const asientos = [];
    for (let i = 0; i < cantidad; i++) {
      const pos = libres[funcion].pop();
      const zona = zonaDe(pos);
      total += zona.precio;
      asientos.push(asientoId(funcion, pos));
      detalle.push([id, sede, asientoId(funcion, pos), zona.nombre, zona.precio]);
    }
    ordenes.push([id, cliente.id, eventoId(funcion), funcion, estado, total, creada]);

    if (estado === 'pagada' || estado === 'cancelada') {
      const metodo = faker.number.int({ min: 1, max: 10 }) <= 7
        ? cliente.pref
        : faker.helpers.arrayElement(['tarjeta', 'transferencia', 'efectivo']);
      const pagado = new Date(creada.getTime() + faker.number.int({ min: 1, max: 9 }) * 60000);
      pagos.push([id, total, metodo, estado === 'pagada' ? 'aprobado' : 'rechazado', 'REF' + faker.string.numeric(10), pagado]);
    }

    if (estado === 'pagada') {
      for (const asiento of asientos) {
        const estadoBoleto = faker.helpers.weightedArrayElement([
          { weight: 85, value: 'emitido' },
          { weight: 12, value: 'usado' },
          { weight: 3, value: 'anulado' },
        ]);
        boletos.push([id, sede, asiento, faker.string.hexadecimal({ length: 32, prefix: '', casing: 'lower' }), estadoBoleto, creada]);
      }
    }
  }

  return { contacto, facturacion, ordenes, detalle, pagos, boletos };
}

async function main() {
  if (!process.env.MYSQL_PASSWORD) {
    console.error('Falta MYSQL_PASSWORD');
    process.exit(1);
  }
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE ?? 'boletera',
  });

  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM clientes_contacto');
  if (n > 0) {
    if (!process.argv.includes('--reiniciar')) {
      console.error('La base ya tiene datos. Usa --reiniciar para borrarlos y volver a cargar.');
      await db.end();
      process.exit(1);
    }
    await db.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['boletos', 'pagos', 'orden_detalle', 'ordenes', 'clientes_facturacion', 'clientes_contacto']) {
      await db.query(`TRUNCATE TABLE ${t}`);
    }
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  faker.seed(2026);
  const d = generar();

  await insertar(db, 'clientes_contacto', ['cliente_id', 'nombre', 'apellidos', 'email', 'telefono', 'ciudad', 'creado_en'], d.contacto);
  await insertar(db, 'clientes_facturacion', ['cliente_id', 'rfc', 'razon_social', 'direccion_fiscal', 'metodo_pago_pref'], d.facturacion);
  await insertar(db, 'ordenes', ['orden_id', 'cliente_id', 'evento_id', 'funcion_id', 'estado', 'total', 'creada_en'], d.ordenes);
  await insertar(db, 'orden_detalle', ['orden_id', 'sede_id', 'asiento_id', 'zona', 'precio'], d.detalle);
  await insertar(db, 'pagos', ['orden_id', 'monto', 'metodo', 'estado', 'referencia', 'pagado_en'], d.pagos);
  await insertar(db, 'boletos', ['orden_id', 'sede_id', 'asiento_id', 'codigo_qr', 'estado', 'emitido_en'], d.boletos);

  let total = 0;
  for (const t of ['clientes_contacto', 'clientes_facturacion', 'ordenes', 'orden_detalle', 'pagos', 'boletos']) {
    const [[{ c }]] = await db.query(`SELECT COUNT(*) AS c FROM ${t}`);
    console.log(t.padEnd(22), c);
    total += c;
  }
  console.log('total'.padEnd(22), total);
  await db.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
