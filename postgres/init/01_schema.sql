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

-- Asientos apartados mientras se cobra. Se particiona igual que asientos para
-- que una compra (que siempre es de una sola sede) toque una sola partición en
-- las dos tablas. orden_id es la orden en MySQL.
--   activa     -> apartado, esperando el pago (vence en 10 minutos)
--   confirmada -> se pagó y el asiento quedó vendido
--   expirada   -> no se pagó a tiempo y el asiento volvió a libre
--   cancelada  -> se rechazó el pago y el asiento volvió a libre
CREATE TABLE reservas_asiento (
  reserva_id BIGSERIAL,
  sede_id    SMALLINT    NOT NULL,
  asiento_id BIGINT      NOT NULL,
  orden_id   BIGINT      NOT NULL,
  expira_en  TIMESTAMPTZ NOT NULL,
  estado     VARCHAR(12) NOT NULL DEFAULT 'activa'
             CHECK (estado IN ('activa', 'confirmada', 'expirada', 'cancelada')),
  PRIMARY KEY (sede_id, reserva_id),
  FOREIGN KEY (sede_id, asiento_id) REFERENCES asientos (sede_id, asiento_id)
) PARTITION BY LIST (sede_id);

CREATE TABLE reservas_ags  PARTITION OF reservas_asiento FOR VALUES IN (1);
CREATE TABLE reservas_cdmx PARTITION OF reservas_asiento FOR VALUES IN (2);
CREATE TABLE reservas_gdl  PARTITION OF reservas_asiento FOR VALUES IN (3);
CREATE TABLE reservas_mty  PARTITION OF reservas_asiento FOR VALUES IN (4);

-- Confirmar o cancelar una compra busca las reservas de su orden.
CREATE INDEX idx_reservas_orden ON reservas_asiento (orden_id);

-- El proceso de expiración (cada minuto) solo busca reservas activas vencidas;
-- el índice parcial guarda solo las activas, así que se mantiene chico.
CREATE INDEX idx_reservas_expiracion ON reservas_asiento (expira_en)
  WHERE estado = 'activa';

-- ---------------------------------------------------------------------------
-- Bitácora del inventario
-- ---------------------------------------------------------------------------

-- Un renglón por cada cambio de estado de un asiento. Solo se inserta, nunca se
-- actualiza, y sirve para reconstruir la historia de un asiento.
--   reserva    -> libre a reservado
--   venta      -> reservado a vendido
--   liberacion -> reservado a libre (reserva expirada o pago rechazado)
CREATE TABLE movimientos_inventario (
  mov_id     BIGSERIAL   PRIMARY KEY,
  sede_id    SMALLINT    NOT NULL,
  asiento_id BIGINT      NOT NULL,
  tipo       VARCHAR(15) NOT NULL
             CHECK (tipo IN ('reserva', 'venta', 'liberacion')),
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (sede_id, asiento_id) REFERENCES asientos (sede_id, asiento_id)
);
