import * as mysql from './modules/mysql/index.js';
import * as postgres from './modules/postgres/index.js';
import * as mongo from './modules/mongo/index.js';

export const servicios = { mysql, postgres, mongo };
