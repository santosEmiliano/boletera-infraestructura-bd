import pg from 'pg';
import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { crearPoolMysql } from './mysql-primario.js';

const { hosts, ...conexionMysql } = config.mysql;
export const mysqlPool = crearPoolMysql(conexionMysql, { hosts });

export const pgPool = new pg.Pool({ ...config.postgres, max: 20, connectionTimeoutMillis: 2000 });
pgPool.on('error', (e) => console.error('postgres:', e.message));

export const mongo = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 2000 });

export const pings = {
  mysql: () => mysqlPool.query('SELECT 1'),
  postgres: () => pgPool.query('SELECT 1'),
  mongo: () => mongo.db().command({ ping: 1 }),
};
