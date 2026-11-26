-- Se corre en el primario cuando el grupo ya está formado, se replica a los demás solo.
-- Requiere @api_clave, @ro_clave y @exporter_clave.
SET @sql = CONCAT("CREATE USER IF NOT EXISTS 'boletera_api'@'%' IDENTIFIED BY '", @api_clave, "'");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
GRANT SELECT, INSERT, UPDATE, DELETE ON boletera.* TO 'boletera_api'@'%';
-- La API pregunta a cada nodo si es el primario para encontrarlo tras una caída
GRANT SELECT ON performance_schema.replication_group_members TO 'boletera_api'@'%';

SET @sql = CONCAT("CREATE USER IF NOT EXISTS 'contacto_ro'@'%' IDENTIFIED BY '", @ro_clave, "'");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
GRANT SELECT ON boletera.clientes_contacto TO 'contacto_ro'@'%';

SET @sql = CONCAT("CREATE USER IF NOT EXISTS 'exporter'@'%' IDENTIFIED BY '", @exporter_clave, "' WITH MAX_USER_CONNECTIONS 3");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'exporter'@'%';
GRANT SELECT ON performance_schema.* TO 'exporter'@'%';
