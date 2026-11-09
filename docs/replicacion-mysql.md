# Replicación de MySQL (Group Replication)

Tres nodos, uno por PC. Un nodo es el primario y acepta escrituras, mientras que los otros dos son secundarios, copian todo y solo permiten lecturas. Si el primario cae, los dos restantes eligen uno nuevo. Para decidir necesitan mayoría (2 de 3), así que el grupo aguanta la caída de un nodo, pero no de dos.

Los nodos se hablan por el puerto 33061, usando los nombres `pc1`, `pc2` y `pc3`.

## Antes de empezar

- Los tres contenedores arriba: `docker compose -f infra/pcX/mysql.yml up -d` en cada PC.
- Los nombres `pc1`, `pc2` y `pc3` deben resolverse desde los contenedores (variables `PCX_IP` del `.env`).
- Si algún volumen `boletera_mysql_data` es de una prueba anterior, borrarlo antes: `docker compose -f infra/pcX/mysql.yml down -v`. Los nodos tienen que empezar sin transacciones propias, y la configuración de arranque solo se aplica con el volumen vacío.

## Formar el grupo

En cada comando, `X` es el número de la PC. Los scripts están en `mysql/scripts/` y los contenedores estan en `/scripts`. Las contraseñas se escriben al momento y no se guardan en ningún archivo.

**1. Usuario de recuperación, en las tres PCs.** Con él, un nodo nuevo se pone al día copiando lo que le falta del grupo.

```bash
docker exec -it mysql-pcX mysql -uroot -p
```

```sql
SET @repl_clave = 'la_clave_que_elijan';
source /scripts/01_recuperacion.sql
```

**2. Arrancar el grupo, solo en pc1 y solo esta vez.**

```sql
source /scripts/02_arrancar_grupo.sql
```

**3. Unir pc2 y luego pc3**, cada uno en su propio contenedor:

```sql
START GROUP_REPLICATION;
```

**4. Verificar**, desde cualquier nodo:

```sql
source /scripts/04_estado.sql
```

Debe verse esto, con los tres en `ONLINE`:

```
+-------------+-------------+--------------+
| MEMBER_HOST | MEMBER_ROLE | MEMBER_STATE |
+-------------+-------------+--------------+
| pc1         | PRIMARY     | ONLINE       |
| pc2         | SECONDARY   | ONLINE       |
| pc3         | SECONDARY   | ONLINE       |
+-------------+-------------+--------------+
```

pc1 ya trae el esquema porque lo carga al arrancar; pc2 y pc3 lo reciben al unirse.

## Después de formarlo

**Usuarios de la aplicación** (en el primario; se copian solos a los demás):

```sql
SET @api_clave = '...', @ro_clave = '...', @exporter_clave = '...';
source /scripts/03_usuarios.sql
```

**Datos de prueba**, contra el primario (ver `mysql/seed/README.md`). Al terminar, contar las filas de `ordenes` en los tres nodos: deben coincidir.

## Qué comprobar y qué se espera

| Prueba | Resultado esperado |
|---|---|
| Insertar en el primario | La fila aparece en los dos secundarios en menos de un segundo |
| Insertar en un secundario | Falla con `--super-read-only`. Es lo normal |
| Detener el contenedor del primario (`docker stop mysql-pcX`) | En unos segundos uno de los dos restantes pasa a PRIMARY |
| Escribir en el nuevo primario | El otro nodo recibe el cambio |
| Volver a levantar el nodo caído | Queda OFFLINE hasta ejecutar `START GROUP_REPLICATION;`. Al hacerlo, se pone al día y vuelve como SECONDARY |

Esto último también pasa al reiniciar una PC: los nodos no se reincorporan solos (`start_on_boot=OFF`), hay que ejecutar `START GROUP_REPLICATION;` en cada uno. Si se reinician los tres a la vez, se vuelve a arrancar el grupo con `02_arrancar_grupo.sql` en un solo nodo, y después se unen los otros dos.

## Problemas que ya aparecieron

**`This member has more executed transactions than those present in the group`.** Al arrancar por primera vez, la imagen de MySQL carga las tablas de zonas horarias con el registro binario activo, y cada nodo queda con cinco transacciones propias que el grupo no conoce. Se evita con `MYSQL_INITDB_SKIP_TZINFO=1`, que ya está en los `mysql.yml`. Si ocurre con un volumen viejo, hay que borrarlo y volver a crearlo.

**`source` dentro de `-e`.** `source` es un comando del cliente `mysql`, no SQL. Funciona dentro de la sesión interactiva o al inicio de una línea, pero no después de un `;` en la misma línea.

**Falta `group_replication_recovery_get_public_key=ON`.** Sin ella, el usuario `repl` puede no poder autenticarse durante la recuperación (el plan lo señala como el error más común). No se ensayó sin ella; está en los `.cnf` por precaución.

**Firewall bloqueando el puerto 33061.** Si un nodo se queda en `RECOVERING` o no se une, revisar que ese puerto esté abierto entre las tres PCs.

## Cómo se probó

Se hizo un ensayo con tres contenedores en una red local de Docker, con los `.cnf` y scripts de este repositorio: formación del grupo, seed contra el primario (74,200 filas en los tres nodos), usuarios, escritura rechazada en un secundario, caída del primario, elección del nuevo y regreso del nodo caído. Lo que no se pudo probar es el paso por la red real entre PCs; en particular, que MySQL acepte `pcX:33061` como dirección local cuando el nombre resuelve a la IP de la PC física y no a la del contenedor.
