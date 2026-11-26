import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { crearPoolMysql } from './mysql-primario.js';
import { crearPoolPostgres } from './postgres-primario.js';

const { hosts, ...conexionMysql } = config.mysql;
export const mysqlPool = crearPoolMysql(conexionMysql, { hosts });

const { hosts: hostsPg, ...conexionPg } = config.postgres;
export const pgPool = crearPoolPostgres(conexionPg, { hosts: hostsPg });

export const mongo = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 2000 });

export const pings = {
  mysql: () => mysqlPool.query('SELECT 1'),
  postgres: () => pgPool.query('SELECT 1'),
  mongo: () => mongo.db().command({ ping: 1 }),
};
