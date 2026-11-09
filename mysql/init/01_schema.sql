-- Boletera: esquema MySQL
-- evento_id, funcion_id, sede_id y asiento_id apuntan a MongoDB/PostgreSQL;
-- entre motores no hay FK, la API valida que existan manualmente.

CREATE DATABASE IF NOT EXISTS boletera CHARACTER SET utf8mb4;
USE boletera;

-- Fragmentación vertical de cliente: contacto y facturación por separado
CREATE TABLE clientes_contacto (
  cliente_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(60)  NOT NULL,
  apellidos  VARCHAR(80)  NOT NULL,
  email      VARCHAR(120) NOT NULL UNIQUE,
  telefono   VARCHAR(20),
  ciudad     VARCHAR(60),
  creado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE clientes_facturacion (
  cliente_id       INT UNSIGNED PRIMARY KEY,
  rfc              VARCHAR(13),
  razon_social     VARCHAR(120),
  direccion_fiscal VARCHAR(200),
  metodo_pago_pref ENUM('tarjeta','transferencia','efectivo') NOT NULL DEFAULT 'tarjeta',
  CONSTRAINT fk_fact_cliente FOREIGN KEY (cliente_id)
    REFERENCES clientes_contacto (cliente_id)
) ENGINE=InnoDB;

CREATE TABLE ordenes (
  orden_id   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cliente_id INT UNSIGNED NOT NULL,
  evento_id  VARCHAR(24) NOT NULL,
  funcion_id INT NOT NULL,
  estado     ENUM('pendiente','pagada','cancelada','expirada') NOT NULL DEFAULT 'pendiente',
  total      DECIMAL(10,2) NOT NULL DEFAULT 0,
  creada_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ord_cliente FOREIGN KEY (cliente_id)
    REFERENCES clientes_contacto (cliente_id),
  INDEX idx_ord_cliente (cliente_id),
  INDEX idx_ord_estado (estado)
) ENGINE=InnoDB;

CREATE TABLE orden_detalle (
  detalle_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  orden_id   BIGINT UNSIGNED NOT NULL,
  sede_id    SMALLINT NOT NULL,
  asiento_id BIGINT NOT NULL,
  zona       VARCHAR(30) NOT NULL,
  precio     DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_det_orden FOREIGN KEY (orden_id) REFERENCES ordenes (orden_id),
  INDEX idx_det_orden (orden_id)
) ENGINE=InnoDB;

CREATE TABLE pagos (
  pago_id    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  orden_id   BIGINT UNSIGNED NOT NULL,
  monto      DECIMAL(10,2) NOT NULL,
  metodo     ENUM('tarjeta','transferencia','efectivo') NOT NULL,
  estado     ENUM('aprobado','rechazado') NOT NULL,
  referencia VARCHAR(40),
  pagado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pago_orden FOREIGN KEY (orden_id) REFERENCES ordenes (orden_id),
  INDEX idx_pago_orden (orden_id)
) ENGINE=InnoDB;

CREATE TABLE boletos (
  boleto_id  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  orden_id   BIGINT UNSIGNED NOT NULL,
  sede_id    SMALLINT NOT NULL,
  asiento_id BIGINT NOT NULL,
  codigo_qr  CHAR(32) NOT NULL UNIQUE,
  estado     ENUM('emitido','usado','anulado') NOT NULL DEFAULT 'emitido',
  emitido_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_bol_orden FOREIGN KEY (orden_id) REFERENCES ordenes (orden_id),
  INDEX idx_bol_orden (orden_id)
) ENGINE=InnoDB;

-- Junta los dos fragmentos para obtener el cliente completo, no es para el usuario contacto_ro
CREATE VIEW clientes_completo AS
SELECT c.cliente_id, c.nombre, c.apellidos, c.email, c.telefono, c.ciudad, c.creado_en,
       f.rfc, f.razon_social, f.direccion_fiscal, f.metodo_pago_pref
FROM clientes_contacto c
LEFT JOIN clientes_facturacion f ON f.cliente_id = c.cliente_id;
