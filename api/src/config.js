const env = process.env;

export const config = {
  puerto: Number(env.PORT ?? 4000),
  mysql: {
    host: env.MYSQL_HOST ?? 'localhost',
    port: Number(env.MYSQL_PORT ?? 3306),
    user: env.MYSQL_USER ?? 'boletera_api',
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE ?? 'boletera',
  },
  postgres: {
    host: env.PG_HOST ?? 'localhost',
    port: Number(env.PG_PORT ?? 5432),
    user: env.PG_USER ?? 'boletera_api',
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE ?? 'boletera',
  },
  mongoUri: env.MONGO_URI ?? 'mongodb://localhost:27017/boletera',
};
