-- Esquema de PostgreSQL para Boletera.
-- Guarda el inventario de asientos: sedes, zonas, funciones, asientos,
-- reservas y movimientos. Las referencias a MySQL (orden_id) y a MongoDB
-- (evento_id) son lógicas: la API valida que existan.
--
-- Se ejecuta solo en el primer arranque del contenedor, dentro de la base
-- indicada en POSTGRES_DB (boletera).

-- ---------------------------------------------------------------------------
-- Catálogo: tablas sin particionar
-- ---------------------------------------------------------------------------

CREATE TABLE sedes (
  sede_id SMALLINT    PRIMARY KEY,
  nombre  VARCHAR(80) NOT NULL,
  ciudad  VARCHAR(40) NOT NULL,
  aforo   INT         NOT NULL
);

-- El sede_id de cada sede define su partición en asientos y reservas_asiento.
INSERT INTO sedes (sede_id, nombre, ciudad, aforo) VALUES
  (1, 'Auditorio Aguascalientes', 'Aguascalientes',   1000),
  (2, 'Foro CDMX',                'Ciudad de Mexico', 1000),
  (3, 'Arena Guadalajara',        'Guadalajara',      1000),
  (4, 'Estadio Monterrey',        'Monterrey',        1000);

-- 10 zonas por sede (40 en total). Cada zona es un bloque de 100 asientos
-- dentro de la función; los nombres y precios los llena el seed.
CREATE TABLE zonas (
  zona_id     SERIAL        PRIMARY KEY,
  sede_id     SMALLINT      NOT NULL REFERENCES sedes (sede_id),
  nombre      VARCHAR(30)   NOT NULL,
  precio_base NUMERIC(10,2) NOT NULL,
  UNIQUE (sede_id, nombre)
);

-- 10 funciones por sede (40 en total). evento_id es el _id del evento en MongoDB.
CREATE TABLE funciones (
  funcion_id SERIAL      PRIMARY KEY,
  evento_id  VARCHAR(24) NOT NULL,
  sede_id    SMALLINT    NOT NULL REFERENCES sedes (sede_id),
  fecha_hora TIMESTAMPTZ NOT NULL,
  estado     VARCHAR(12) NOT NULL DEFAULT 'abierta'
);

-- GET /api/funciones?evento_id= busca por esta columna.
CREATE INDEX idx_funciones_evento ON funciones (evento_id);
