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

-- ---------------------------------------------------------------------------
-- Fragmentación horizontal: PARTITION BY LIST (sede_id)
-- Cada sede opera de forma independiente y toda consulta de asientos filtra
-- por sede, así que PostgreSQL solo lee la partición que toca (partition
-- pruning). La llave primaria y los UNIQUE deben incluir sede_id, porque cada
-- partición solo puede garantizar unicidad dentro de sí misma.
-- ---------------------------------------------------------------------------

-- 1,000 asientos por función (40,000 en total). asiento_id va de 1 a 10,000
-- dentro de cada sede y lo asigna el seed, no una secuencia, para que coincida
-- con los (sede_id, asiento_id) que guarda MySQL en orden_detalle y boletos.
CREATE TABLE asientos (
  asiento_id BIGINT      NOT NULL,
  sede_id    SMALLINT    NOT NULL REFERENCES sedes (sede_id),
  funcion_id INT         NOT NULL REFERENCES funciones (funcion_id),
  zona_id    INT         NOT NULL REFERENCES zonas (zona_id),
  fila       CHAR(2)     NOT NULL,
  numero     SMALLINT    NOT NULL,
  estado     VARCHAR(12) NOT NULL DEFAULT 'libre'
             CHECK (estado IN ('libre', 'reservado', 'vendido')),
  PRIMARY KEY (sede_id, asiento_id),
  UNIQUE (sede_id, funcion_id, fila, numero)
) PARTITION BY LIST (sede_id);

CREATE TABLE asientos_ags  PARTITION OF asientos FOR VALUES IN (1);
CREATE TABLE asientos_cdmx PARTITION OF asientos FOR VALUES IN (2);
CREATE TABLE asientos_gdl  PARTITION OF asientos FOR VALUES IN (3);
CREATE TABLE asientos_mty  PARTITION OF asientos FOR VALUES IN (4);

-- Asientos libres de una función: se crea en cada partición.
CREATE INDEX idx_asientos_funcion ON asientos (funcion_id, estado);
