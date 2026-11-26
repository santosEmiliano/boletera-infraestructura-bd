import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearPoolPostgres, separarHost } from '../src/postgres-primario.js';

const error = (code, mensaje = code) => Object.assign(new Error(mensaje), { code });

// Dos nodos simulados. 'primario' escribe, 'replica' responde 25006 al escribir
// y 'caido' rechaza la conexión.
function simular(estados, opciones = {}) {
  const nodos = { ...estados };
  const llamadas = [];
  const preguntas = [];
  const ejecutar = async (host, sql) => {
    if (nodos[host] === 'caido') throw error('ECONNREFUSED');
    if (nodos[host] === 'cortado') throw error('57P01', 'terminating connection due to administrator command');
    // Sigue siendo primario, pero esta conexión se cortó
    if (nodos[host] === 'parpadeo') throw error('ECONNRESET');
    if (nodos[host] === 'replica' && /^(INSERT|UPDATE)/.test(sql)) {
      throw error('25006', 'cannot execute UPDATE in a read-only transaction');
    }
    llamadas.push([host, sql]);
    return { rows: [{ host }] };
  };
  const pool = crearPoolPostgres({ port: 5432 }, {
    hosts: Object.keys(nodos),
    esperaMs: 300,
    cadaMs: 10,
    verificarCadaMs: 0,
    buscarAlInicio: false,
    crearPool: (host) => ({
      query: (sql) => ejecutar(host, sql),
      connect: async () => {
        if (nodos[host] === 'caido') throw error('ECONNREFUSED');
        return { query: (sql) => ejecutar(host, sql), release() {} };
      },
      end: async () => {},
    }),
    preguntar: async (host) => {
      preguntas.push(host);
      if (nodos[host] === 'caido') throw error('ECONNREFUSED');
      return nodos[host] === 'primario' || nodos[host] === 'parpadeo';
    },
    ...opciones,
  });
  return { nodos, llamadas, preguntas, pool };
}

test('separarHost acepta el nombre solo o con puerto', () => {
  assert.deepEqual(separarHost('pc2', 5432), { host: 'pc2', port: 5432 });
  assert.deepEqual(separarHost('localhost:5434', 5432), { host: 'localhost', port: 5434 });
});

test('antes de la primera operación confirma quién es el primario', async () => {
  const { pool, llamadas } = simular({ pc2: 'replica', pc3: 'primario' });
  await pool.query('SELECT 1');
  assert.deepEqual(llamadas, [['pc3', 'SELECT 1']]);
  assert.equal(pool.primarioActual(), 'pc3');
});

test('cae el primario y se promueve la réplica: la consulta espera y sale en el nuevo', async () => {
  const { pool, nodos, llamadas } = simular({ pc2: 'primario', pc3: 'replica' });
  await pool.query('UPDATE a SET x = 1');
  nodos.pc2 = 'caido';
  setTimeout(() => { nodos.pc3 = 'primario'; }, 80);
  await pool.query('UPDATE a SET x = 2');
  assert.deepEqual(llamadas.map(([h]) => h), ['pc2', 'pc3']);
  assert.equal(pool.primarioActual(), 'pc3');
});

test('una escritura que cae en la réplica (25006) busca al primario y se repite', async () => {
  const { pool, nodos, llamadas } = simular({ pc2: 'primario', pc3: 'replica' });
  await pool.query('SELECT 1');
  // pc2 volvió como réplica de pc3 sin que ninguna conexión fallara
  nodos.pc2 = 'replica';
  nodos.pc3 = 'primario';
  await pool.query('UPDATE a SET x = 1');
  assert.deepEqual(llamadas.at(-1), ['pc3', 'UPDATE a SET x = 1']);
});

test('si nadie se promueve a tiempo, falla con SIN_PRIMARIO', async () => {
  const { pool, nodos } = simular({ pc2: 'primario', pc3: 'replica' });
  await pool.query('SELECT 1');
  nodos.pc2 = 'caido';
  await assert.rejects(pool.query('UPDATE a SET x = 1'), (e) => e.code === 'SIN_PRIMARIO');
});

test('un error que pudo haberse ejecutado busca al primario pero no se repite', async () => {
  const { pool, nodos, llamadas } = simular({ pc2: 'primario', pc3: 'replica' });
  await pool.query('SELECT 1');
  nodos.pc2 = 'cortado';
  nodos.pc3 = 'primario';
  await assert.rejects(pool.query('UPDATE a SET x = 1'), (e) => e.code === '57P01');
  assert.equal(pool.primarioActual(), 'pc3');
  assert.equal(llamadas.length, 1);
});

test('dos primarios al arrancar: no elige ninguno', async () => {
  const { pool, llamadas } = simular({ pc2: 'primario', pc3: 'primario' });
  await assert.rejects(pool.query('SELECT 1'), (e) => e.code === 'SIN_PRIMARIO');
  assert.deepEqual(llamadas, []);
});

test('el viejo primario vuelve sin reconstruirse: se sigue con el nuevo', async () => {
  const { pool, nodos, llamadas } = simular({ pc2: 'primario', pc3: 'replica' });
  await pool.query('SELECT 1');
  nodos.pc2 = 'caido';
  nodos.pc3 = 'primario';
  await pool.query('UPDATE a SET x = 1');
  nodos.pc2 = 'primario';
  nodos.pc3 = 'parpadeo';
  // pc3 corta una conexión: se vuelve a buscar y aparecen dos primarios
  await assert.rejects(pool.query('UPDATE a SET x = 2'), (e) => e.code === 'ECONNRESET');
  assert.equal(pool.primarioActual(), 'pc3');
  assert.ok(!llamadas.some(([h, sql]) => h === 'pc2' && sql.startsWith('UPDATE')));
});

test('varias consultas fallando a la vez comparten una sola búsqueda', async () => {
  const { pool, nodos, preguntas } = simular({ pc2: 'primario', pc3: 'replica' });
  await pool.query('SELECT 1');
  preguntas.length = 0;
  nodos.pc2 = 'caido';
  nodos.pc3 = 'primario';
  await Promise.all([1, 2, 3, 4, 5].map((n) => pool.query(`UPDATE a SET x = ${n}`)));
  assert.deepEqual(preguntas.sort(), ['pc2', 'pc3']);
});

test('en una transacción el error sigue su camino y la siguiente usa el nuevo primario', async () => {
  const { pool, nodos } = simular({ pc2: 'primario', pc3: 'replica' });
  const cliente = await pool.connect();
  nodos.pc2 = 'cortado';
  nodos.pc3 = 'primario';
  await assert.rejects(cliente.query('UPDATE a SET x = 1'), (e) => e.code === '57P01');
  cliente.release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pool.primarioActual(), 'pc3');
  const otro = await pool.connect();
  assert.deepEqual((await otro.query('UPDATE a SET x = 2')).rows, [{ host: 'pc3' }]);
});

test('con un solo nodo no busca nada', async () => {
  const preguntas = [];
  const pool = crearPoolPostgres({ port: 5432 }, {
    hosts: ['pc2'],
    crearPool: () => ({ query: async () => ({ rows: [] }), end: async () => {} }),
    preguntar: async (h) => { preguntas.push(h); return true; },
  });
  await pool.query('SELECT 1');
  assert.deepEqual(preguntas, []);
});
