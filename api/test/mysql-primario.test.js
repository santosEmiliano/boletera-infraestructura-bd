import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearPoolMysql } from '../src/mysql-primario.js';

const error = (code) => Object.assign(new Error(code), { code });

// Tres nodos simulados. 'primario' escribe, 'secundario' responde 1290 al escribir
// y 'caido' rechaza la conexión.
function simular(estados) {
  const nodos = { ...estados };
  const llamadas = [];
  const preguntas = [];
  const conexionDe = (host) => ({
    query: (sql) => conexionDe(host).execute(sql),
    execute: async (sql) => {
      if (nodos[host] === 'caido') throw error('ECONNREFUSED');
      if (nodos[host] === 'secundario' && /^(INSERT|UPDATE)/.test(sql)) throw error('ER_OPTION_PREVENTS_STATEMENT');
      if (nodos[host] === 'cortado') throw error('ECONNRESET');
      llamadas.push([host, sql]);
      return [[{ host }]];
    },
    release() {},
    commit: async () => {},
    beginTransaction: async () => {},
  });
  const opciones = {
    hosts: Object.keys(nodos),
    esperaMs: 300,
    cadaMs: 10,
    verificarCadaMs: 0,
    buscarAlInicio: false,
    crearPool: (host) => ({
      execute: (sql) => conexionDe(host).execute(sql),
      query: (sql) => conexionDe(host).execute(sql),
      getConnection: async () => {
        if (nodos[host] === 'caido') throw error('ECONNREFUSED');
        return conexionDe(host);
      },
      end: async () => {},
    }),
    preguntar: async (host) => {
      preguntas.push(host);
      if (nodos[host] === 'caido') throw error('ECONNREFUSED');
      return nodos[host] === 'primario';
    },
  };
  return { nodos, llamadas, preguntas, pool: crearPoolMysql({}, opciones) };
}

test('si arranca en un secundario, la primera escritura encuentra al primario y sale bien', async () => {
  const { pool, llamadas } = simular({ pc1: 'secundario', pc2: 'primario', pc3: 'secundario' });
  await pool.execute('UPDATE ordenes SET estado = 1');
  assert.deepEqual(llamadas, [['pc2', 'UPDATE ordenes SET estado = 1']]);
  assert.equal(pool.primarioActual(), 'pc2');
});

test('las lecturas no buscan nada: un secundario las responde', async () => {
  const { pool, preguntas } = simular({ pc1: 'secundario', pc2: 'primario', pc3: 'secundario' });
  await pool.execute('SELECT 1');
  assert.deepEqual(preguntas, []);
  assert.equal(pool.primarioActual(), 'pc1');
});

test('cae el primario: espera a que el grupo elija otro y la escritura sale', async () => {
  const { pool, nodos, llamadas } = simular({ pc1: 'primario', pc2: 'secundario', pc3: 'secundario' });
  await pool.execute('UPDATE a SET x = 1');
  nodos.pc1 = 'caido';
  setTimeout(() => { nodos.pc3 = 'primario'; }, 80);
  await pool.execute('UPDATE a SET x = 2');
  assert.deepEqual(llamadas.map(([h]) => h), ['pc1', 'pc3']);
  assert.equal(pool.primarioActual(), 'pc3');
});

test('si no aparece ningún primario a tiempo, falla con SIN_PRIMARIO', async () => {
  const { pool, nodos } = simular({ pc1: 'primario', pc2: 'secundario', pc3: 'secundario' });
  nodos.pc1 = 'caido';
  await assert.rejects(pool.execute('UPDATE a SET x = 1'), (e) => e.code === 'SIN_PRIMARIO');
});

test('varias peticiones fallando a la vez comparten una sola búsqueda', async () => {
  const { pool, nodos, preguntas } = simular({ pc1: 'primario', pc2: 'secundario', pc3: 'secundario' });
  await pool.execute('SELECT 1');
  nodos.pc1 = 'caido';
  nodos.pc2 = 'primario';
  await Promise.all(Array.from({ length: 10 }, () => pool.execute('UPDATE a SET x = 1')));
  assert.equal(preguntas.length, 3, 'una ronda: un pregunta por nodo');
});

test('un error ambiguo busca al primario pero no repite la sentencia', async () => {
  const { pool, nodos, llamadas } = simular({ pc1: 'primario', pc2: 'secundario', pc3: 'secundario' });
  nodos.pc1 = 'cortado';
  nodos.pc2 = 'primario';
  await assert.rejects(pool.execute('INSERT INTO a VALUES (1)'), (e) => e.code === 'ECONNRESET');
  assert.equal(llamadas.length, 0, 'no se repitió');
  assert.equal(pool.primarioActual(), 'pc2');
  await pool.execute('INSERT INTO a VALUES (1)');
  assert.deepEqual(llamadas.map(([h]) => h), ['pc2']);
});

test('un error que no es de conexión no busca nada', async () => {
  const preguntas = [];
  const aparte = crearPoolMysql({}, {
    hosts: ['pc1', 'pc2'],
    verificarCadaMs: 0,
    buscarAlInicio: false,
    crearPool: () => ({ execute: async () => { throw error('ER_DUP_ENTRY'); }, end: async () => {} }),
    preguntar: async (h) => { preguntas.push(h); return true; },
  });
  await assert.rejects(aparte.execute('INSERT'), (e) => e.code === 'ER_DUP_ENTRY');
  assert.deepEqual(preguntas, []);
});

test('en una transacción, el error avisa del cambio y la siguiente conexión ya va al primario nuevo', async () => {
  const { pool, nodos, llamadas } = simular({ pc1: 'primario', pc2: 'secundario', pc3: 'secundario' });
  const conn = await pool.getConnection();
  nodos.pc1 = 'cortado';
  nodos.pc2 = 'primario';
  await assert.rejects(conn.execute('INSERT INTO a VALUES (1)'), (e) => e.code === 'ECONNRESET');
  const otra = await pool.getConnection();
  await otra.execute('INSERT INTO a VALUES (1)');
  assert.deepEqual(llamadas.map(([h]) => h), ['pc2']);
});

function conVigilancia(estados, extra = {}) {
  const nodos = { ...estados };
  const escrituras = [];
  const pool = crearPoolMysql({}, {
    hosts: Object.keys(nodos),
    esperaMs: 300,
    cadaMs: 10,
    crearPool: (host) => ({
      execute: async () => { escrituras.push(host); return [[]]; },
      end: async () => {},
    }),
    preguntar: async (host) => nodos[host] === 'primario',
    ...extra,
  });
  return { nodos, escrituras, pool };
}

test('al arrancar busca al primario aunque el primer nodo acepte escrituras', async () => {
  // pc1 reinició fuera del grupo: escribiría sin ningún error, pero no es el primario
  const { pool, escrituras } = conVigilancia({ pc1: 'aislado', pc2: 'primario', pc3: 'secundario' }, { verificarCadaMs: 0 });
  await pool.execute('UPDATE a SET x = 1');
  assert.deepEqual(escrituras, ['pc2']);
  await pool.end();
});

test('si el nodo actual deja de ser el primario sin dar errores, lo detecta y cambia', async () => {
  const { pool, nodos, escrituras } = conVigilancia({ pc1: 'primario', pc2: 'secundario', pc3: 'secundario' }, { verificarCadaMs: 20 });
  await pool.execute('UPDATE a SET x = 1');
  nodos.pc1 = 'aislado';
  nodos.pc3 = 'primario';
  await new Promise((r) => setTimeout(r, 150));
  await pool.execute('UPDATE a SET x = 2');
  assert.deepEqual(escrituras, ['pc1', 'pc3']);
  await pool.end();
});

test('con un solo nodo no pregunta nada ni espera: es un MySQL sin grupo', async () => {
  const preguntas = [];
  const pool = crearPoolMysql({}, {
    hosts: ['pc1'],
    crearPool: () => ({ execute: async () => [[{ ok: 1 }]], end: async () => {} }),
    preguntar: async (h) => { preguntas.push(h); return false; },
  });
  assert.deepEqual((await pool.execute('SELECT 1'))[0], [{ ok: 1 }]);
  assert.deepEqual(preguntas, []);
  assert.equal(pool.primarioActual(), 'pc1');
  await pool.end();
});
