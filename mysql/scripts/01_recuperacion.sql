-- Se corre en los tres nodos, con @repl_clave definida antes.
SET sql_log_bin = 0;

SET @sql = CONCAT("CREATE USER IF NOT EXISTS 'repl'@'%' IDENTIFIED BY '", @repl_clave, "'");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

GRANT REPLICATION SLAVE, CONNECTION_ADMIN, BACKUP_ADMIN, GROUP_REPLICATION_STREAM
  ON *.* TO 'repl'@'%';

SET sql_log_bin = 1;

SET @sql = CONCAT("CHANGE REPLICATION SOURCE TO SOURCE_USER='repl', SOURCE_PASSWORD='",
                  @repl_clave, "' FOR CHANNEL 'group_replication_recovery'");
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
