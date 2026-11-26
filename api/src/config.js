const env = process.env;

export const config = {
  puerto: Number(env.PORT ?? 4000),
  mysql: {
    // Nodos del grupo, separados por comas. La API busca entre ellos al primario
    hosts: (env.MYSQL_HOSTS ?? env.MYSQL_HOST ?? 'localhost').split(',').map((h) => h.trim()).filter(Boolean),
    port: Number(env.MYSQL_PORT ?? 3306),
    user: env.MYSQL_USER ?? 'boletera_api',
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE ?? 'boletera',
  },
  postgres: {
    // Primario y réplica, separados por comas ("pc2,pc3" o "host:puerto"). La API
    // busca entre ellos al primario
    hosts: (env.PG_HOSTS ?? env.PG_HOST ?? 'localhost').split(',').map((h) => h.trim()).filter(Boolean),
    port: Number(env.PG_PORT ?? 5432),
    user: env.PG_USER ?? 'boletera_api',
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE ?? 'boletera',
  },
  mongoUri: env.MONGO_URI ?? 'mongodb://localhost:27017/boletera',
};
