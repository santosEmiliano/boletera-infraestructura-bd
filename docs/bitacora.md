# Bitácora de problemas y soluciones

Una entrada por problema, en el orden en que aparecieron. Sirve para no tropezar dos veces con lo mismo y como evidencia de cómo se resolvió cada falla. Cuando no se registró la hora exacta, solo va la fecha.

Formato:

```
Fecha / hora:    2026-11-06 18:40
Quién:           ...
Servicio:        ...
Síntoma:         ...
Causa:           ...
Solución:        ...
Cómo evitarlo:   ...
```

---

## PostgreSQL: el puerto 5432 ya estaba ocupado

```
Fecha / hora:    2026-11-22
Quién:           Harim
Servicio:        PostgreSQL, compose de PC2 (infra/pc2/postgres.yml)
Síntoma:         docker compose up falla con "port is already allocated" en el 5432.
Causa:           Otro PostgreSQL de la misma máquina (contenedor tara_postgres, de otro
                 proyecto) ya publicaba el 5432.
Solución:        El puerto publicado se volvió variable: POSTGRES_PORT en el .env
                 (5432 por defecto). Las pruebas en esa máquina usan 5433.
Cómo evitarlo:   Antes de levantar, revisar con docker ps qué puertos están ocupados.
                 En la red real cada PC usa 5432.
```

## PostgreSQL: "invalid hostPort" al levantar

```
Fecha / hora:    2026-11-22
Quién:           Harim
Servicio:        PostgreSQL, compose de PC2
Síntoma:         docker compose responde "invalid hostPort: =5433".
Causa:           En el .env quedó POSTGRES_PORT==5433 (dos signos =): el valor de la
                 variable era "=5433".
Solución:        Corregir la línea a POSTGRES_PORT=5433.
Cómo evitarlo:   docker compose -f ... config muestra los valores ya sustituidos; revisar
                 ahí el puerto antes de levantar.
```

## Scripts .sh con fin de línea CRLF

```
Fecha / hora:    2026-11-22
Quién:           Harim
Servicio:        PostgreSQL, postgres/init/02_pg_hba_replicacion.sh
Síntoma:         Dentro del contenedor el script falla con "\r: command not found".
Causa:           Con core.autocrlf=true en Windows, git entrega los .sh con CRLF, y bash
                 en Linux no los entiende.
Solución:        .gitattributes con "*.sh text eol=lf": git los entrega siempre con LF.
Cómo evitarlo:   Todo script que se monte en un contenedor Linux debe estar cubierto
                 por .gitattributes.
```

## PostgreSQL: pg_basebackup interrumpido

```
Fecha / hora:    2026-11-22
Quién:           Harim
Servicio:        PostgreSQL, réplica en PC3
Síntoma:         La copia del primario se corta antes de terminar.
Causa:           Se escribió en la terminal mientras corría pg_basebackup y un Ctrl+C lo
                 interrumpió.
Solución:        Borrar el volumen de la réplica y repetir la copia completa.
Cómo evitarlo:   No escribir nada hasta que salga el 100 % y regrese el prompt. Está
                 marcado en docs/replicacion-postgres.md.
```

## Simulador: los stubs se agotan y parecen caídas

```
Fecha / hora:    2026-11-22
Quién:           Harim
Servicio:        Simulador de compras contra los stubs de la API
Síntoma:         En corridas largas casi todas las compras fallan y el reporte las cuenta
                 como caídas; al reiniciar la API aparecen miles de "dobles ventas".
Causa:           Los stubs guardaban las ventas en memoria: se vendían los 40,000
                 asientos, y al reiniciar la API se olvidaban y se volvían a vender.
Solución:        El simulador distingue la categoría "agotada" y no la cuenta como caída.
                 La doble venta tras un reinicio quedó documentada como efecto de los
                 stubs (simulator/README.md).
Cómo evitarlo:   Las pruebas de doble venta valen contra las bases reales, no contra los
                 stubs.
```

## MongoDB: el script de los shards no encontraba el nombre del replica set

```
Fecha / hora:    2026-11-25
Quién:           Harim
Servicio:        MongoDB, mongo/scripts/03_iniciar_shard.js
Síntoma:         rs.initiate falla con "BSON field 'ReplSetConfig._id' is missing".
Causa:           El script leía replication.replSetName de getCmdLineOpts. Ese nombre solo
                 existe con archivo de configuración; con --replSet en la línea de
                 comandos el campo se llama replication.replSet.
Solución:        El script acepta los dos nombres.
Cómo evitarlo:   Probar los scripts contra el mismo arranque que se usa de verdad (los
                 compose pasan todo por línea de comandos).
```

## MongoDB: mongos rechaza la conexión al configurar el sharding

```
Fecha / hora:    2026-11-26
Quién:           Harim
Servicio:        MongoDB, mongos (simulación)
Síntoma:         04_configurar_sharding.js falla con "connect ECONNREFUSED 127.0.0.1:27017".
Causa:           mongos no abre su puerto hasta conectarse a los config servers, y se
                 corrió el script segundos después de iniciar cfgRS.
Solución:        Esperar y repetir. La simulación tiene ahora un healthcheck en mongos:
                 docker compose ps lo muestra "healthy" cuando ya se puede usar.
Cómo evitarlo:   Antes del 04, comprobar que mongos esté "healthy". Está en
                 docs/mongo-sharding.md.
```

## MongoDB: bitacora_accesos fragmentada por un campo que nadie guarda

```
Fecha / hora:    2026-11-26
Quién:           Harim
Servicio:        MongoDB, colección bitacora_accesos
Síntoma:         Al comparar el modelo con el módulo de Mongo de la API: la colección se
                 fragmentaba por evento_id, pero la API no guarda evento_id en los accesos.
Causa:           El modelo y el módulo de la API se escribieron por separado.
Solución:        Shard key cambiada a { codigo_qr: "hashed" }, que todos los accesos
                 tienen. Con 2,000 accesos de prueba quedó 999 / 1,001 entre los shards.
                 El modelo (mongo/seed/modelo.md) se alineó con el resto del código.
Cómo evitarlo:   Revisar la shard key contra el código que inserta, no solo contra el
                 diseño. Sin la shard key todo cae en un solo trozo y no hay error que
                 avise.
```

## PostgreSQL: la réplica no arranca

```
Fecha / hora:    2026-11-26
Quién:           Harim
Servicio:        PostgreSQL, réplica (simulación)
Síntoma:         El contenedor de la réplica se detiene solo al levantarlo; docker exec
                 responde "container is not running".
Causa:           Se levantó con el volumen vacío, sin correr antes pg_basebackup. La
                 réplica no lleva POSTGRES_PASSWORD a propósito, así que intentó crear
                 una base nueva y se detuvo.
Solución:        Borrar el contenedor y el volumen de la réplica, correr pg_basebackup y
                 levantarla.
Cómo evitarlo:   El orden es siempre: rol y slot en el primario, pg_basebackup, y después
                 levantar la réplica (docs/replicacion-postgres.md).
```

## API: "no hay un primario disponible" sin decir por qué

```
Fecha / hora:    2026-11-26
Quién:           Harim
Servicio:        API, pool de PostgreSQL (src/postgres-primario.js)
Síntoma:         La sonda de failover se detiene al arrancar con "PostgreSQL: no hay un
                 primario disponible", con los dos nodos arriba.
Causa:           PG_PASSWORD equivocada: los dos nodos rechazaban la conexión. El error
                 no lo decía porque la búsqueda del primario descartaba la causa.
Solución:        El error ahora lleva la causa de cada nodo, por ejemplo
                 "(localhost:5433: password authentication failed ...)".
Cómo evitarlo:   Leer la causa entre paréntesis. La tabla de docs/procedimientos-falla.md
                 dice qué hacer con cada una.
```

## Git: GitHub rechaza el push de una rama

```
Fecha / hora:    2026-11-26
Quién:           Harim
Servicio:        Repositorio
Síntoma:         git push de feat/monitoreo/exporters falla con "cannot lock ref ...
                 'refs/heads/feat/monitoreo' exists".
Causa:           git guarda las ramas como rutas: si existe la rama feat/monitoreo, no
                 puede existir feat/monitoreo/<algo>.
Solución:        Renombrar la rama local (git branch -m feat/exporters-bases) y subirla.
Cómo evitarlo:   Antes de crear una rama con "/", revisar con git ls-remote --heads origin
                 que ninguna rama existente sea el inicio de su nombre.
```
