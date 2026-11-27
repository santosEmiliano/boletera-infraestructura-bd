#!/bin/bash
# Levanta Boletera desde PC1 (la Mac), con los datos que ya existen en los volúmenes.
# Es el arranque de todos los días, no la instalación desde cero: no carga seeds,
# no crea usuarios ni copia PostgreSQL con pg_basebackup (ver la guía de arranque).
#
#   1. Revisa Docker, los archivos de claves y que pc2 y pc3 respondan en la red.
#   2. Enciende los contenedores de PC1 (MySQL, Mongo, exporters, monitoreo).
#   3. Espera a que MySQL, PostgreSQL y Mongo de pc2 y pc3 respondan.
#   4. Forma el grupo de MySQL: si ya hay un primario, une a los nodos que falten;
#      si no, arranca el grupo en el nodo que tiene todos los datos y une a los demás.
#   5. Revisa PostgreSQL (un primario, la réplica en streaming) y Mongo (un primario
#      en cfgRS, shardA y shardB, y los dos mongos).
#   6. Enciende la API en segundo plano y espera a que /health diga ok en los tres.
#
# Si algo indispensable falla, deshace lo que este script hizo, en orden inverso:
# apaga la API, saca del grupo a los nodos de MySQL que unió y detiene los
# contenedores de PC1 que encendió. Nunca borra volúmenes ni datos, y no toca lo que
# ya estaba corriendo antes de empezar.
#
# Uso, desde la raíz del repo:
#
#   bash levantar.sh               # levanta todo
#   bash levantar.sh --revisar     # solo muestra el estado, no cambia nada
#   bash levantar.sh --sin-api     # todo menos la API
#   bash levantar.sh --sin-revertir  # si algo falla, deja todo como quedó
#
# En pc2 y pc3 no hay que correr nada si Docker Desktop está abierto: los
# contenedores tienen restart: unless-stopped. Si alguno no responde, el script
# dice qué comando correr en esa PC.
#
# Las claves se leen de infra/pc1/.env y de la carpeta de claves (por omisión
# ~/Desktop/boletera-env; se cambia con BOLETERA_ENV=...). Nunca se imprimen.
#
# Escrito para el bash 3.2 que trae macOS.
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")" && pwd)"
cd "$RAIZ"

ENV_DIR="${BOLETERA_ENV:-$HOME/Desktop/boletera-env}"
ENV_PC1="$RAIZ/infra/pc1/.env"
LOG_DIR="$RAIZ/logs"
LOG_API="$LOG_DIR/api.log"
PID_API="$LOG_DIR/api.pid"

CLIENTE_MYSQL=boletera-cliente-mysql
CLIENTE_PG=boletera-cliente-pg
COMPOSE_PC1="mysql mongo exporters monitoring"

# Tiempos máximos de espera, en segundos
T_REMOTO=${T_REMOTO:-300}     # que pc2 y pc3 respondan
T_LOCAL=${T_LOCAL:-180}       # que un contenedor de PC1 diga healthy
T_GRUPO=${T_GRUPO:-120}       # que un nodo de MySQL quede ONLINE
T_MONGO=${T_MONGO:-120}       # que cada replica set de Mongo tenga primario
T_PG=${T_PG:-90}              # que la réplica de PostgreSQL esté en streaming
T_API=${T_API:-90}            # que /health diga ok

REVISAR=0; SIN_API=0; SIN_REVERTIR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --revisar) REVISAR=1; shift ;;
    --sin-api) SIN_API=1; shift ;;
    --sin-revertir) SIN_REVERTIR=1; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $1 (usa --help)"; exit 1 ;;
  esac
done
# Para solo revisar no tiene caso esperar minutos
if [ "$REVISAR" = 1 ]; then T_REMOTO=10; T_LOCAL=10; T_GRUPO=5; T_MONGO=10; T_PG=5; fi

# --- Salida en pantalla ---------------------------------------------------------
verde() { printf '\033[32m%s\033[0m\n' "$1"; }
amarillo() { printf '\033[33m%s\033[0m\n' "$1"; }
rojo() { printf '\033[31m%s\033[0m\n' "$1"; }
titulo() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok() { verde "  OK   $1"; }
aviso() { amarillo "  AVISO $1"; AVISOS=$((AVISOS + 1)); }
AVISOS=0

# --- Deshacer --------------------------------------------------------------------
# Cada cambio que hace el script agrega aquí el comando que lo revierte.
DESHACER=()
registrar() { DESHACER+=("$1"); }

revertir() {
  local i
  if [ "$SIN_REVERTIR" = 1 ]; then
    amarillo "--sin-revertir: se deja todo como quedó."
    return
  fi
  if [ ${#DESHACER[@]} -eq 0 ]; then
    echo "No había nada que deshacer: el script no alcanzó a cambiar nada."
    return
  fi
  titulo "Deshaciendo lo que hizo este script"
  for ((i = ${#DESHACER[@]} - 1; i >= 0; i--)); do
    echo "  - ${DESHACER[$i]%%|*}"
    eval "${DESHACER[$i]#*|}" >/dev/null 2>&1 || amarillo "    no se pudo; revísalo a mano"
  done
  verde "Listo. Los datos no se tocaron."
}

limpiar_clientes() {
  docker rm -f "$CLIENTE_MYSQL" "$CLIENTE_PG" >/dev/null 2>&1 || true
}

FALLO=0
fallar() {
  FALLO=1
  echo
  rojo "ERROR: $1"
  [ $# -gt 1 ] && printf '%s\n' "$2"
  revertir
  limpiar_clientes
  exit 1
}
# critico: en --revisar solo avisa y sigue; si no, falla y deshace
critico() {
  if [ "$REVISAR" = 1 ]; then aviso "$1"; else fallar "$@"; fi
}
trap 'fallar "Se interrumpió el script."' INT TERM
trap 'limpiar_clientes' EXIT

# esperar <segundos> <descripción> <comando...>: repite el comando cada 3 s
esperar() {
  local limite=$1 descripcion=$2 inicio
  shift 2
  inicio=$(date +%s)
  printf '  ...  %s' "$descripcion"
  until "$@" >/dev/null 2>&1; do
    if [ $(( $(date +%s) - inicio )) -ge "$limite" ]; then
      printf '\n'
      return 1
    fi
    printf '.'
    sleep 3
  done
  printf ' (%ss)\n' $(( $(date +%s) - inicio ))
}

# --- Claves (se exportan para pasarlas a los contenedores por nombre, -e VAR) ------
leer() { grep -E "^$1=" "$2" 2>/dev/null | head -1 | cut -d= -f2-; }

# =================================================================================
titulo "1. Revisión previa"

curl -s --max-time 4 --unix-socket "$HOME/.docker/run/docker.sock" http://localhost/_ping >/dev/null \
  || fallar "Docker no responde." "Abre Docker Desktop (o reinícialo) y vuelve a correr el script."
ok "Docker responde"

[ -f "$ENV_PC1" ] || fallar "No existe infra/pc1/.env." "Cópialo de $ENV_DIR/pc1.env."
[ -f "$ENV_DIR/pc2.env" ] || fallar "No encuentro $ENV_DIR/pc2.env." "Usa BOLETERA_ENV=/ruta/a/la/carpeta bash levantar.sh"
[ "$SIN_API" = 1 ] || [ -f api/.env ] || fallar "No existe api/.env." "Cópialo de $ENV_DIR/api.env."

PC1_IP=$(leer PC1_IP "$ENV_PC1"); PC2_IP=$(leer PC2_IP "$ENV_PC1"); PC3_IP=$(leer PC3_IP "$ENV_PC1")
MYSQL_PWD=$(leer MYSQL_ROOT_PASSWORD "$ENV_PC1"); export MYSQL_PWD
PGPASSWORD=$(leer POSTGRES_PASSWORD "$ENV_DIR/pc2.env"); export PGPASSWORD
for v in PC1_IP PC2_IP PC3_IP MYSQL_PWD PGPASSWORD; do
  [ -n "${!v}" ] || fallar "Falta un valor en los .env ($v)."
done
ok "Claves leídas (sin mostrarlas)"

IP_LOCAL=$(ifconfig | awk '/inet /{print $2}' | grep -Fx "$PC1_IP" || true)
[ -n "$IP_LOCAL" ] || fallar "Esta Mac no tiene la IP $PC1_IP." \
  "Conecta el cable y revisa la IP con: ifconfig | awk '/^[a-z]/{i=\$1} /inet /{print i, \$2}'"
ok "Esta Mac es pc1 ($PC1_IP)"

for par in "pc2 $PC2_IP" "pc3 $PC3_IP"; do
  set -- $par
  # Se prueba un puerto y no el ping: Windows a veces bloquea el ping al
  # reiniciarse aunque los servicios sí respondan
  nc -z -G 3 "$2" 3306 >/dev/null 2>&1 || nc -z -G 3 "$2" 5432 >/dev/null 2>&1 \
    || fallar "$1 ($2) no responde." "Revisa el cable, que esté encendida, que Docker Desktop esté abierto y su IP con ipconfig."
  ok "$1 ($2) responde"
done

# Contenedores de apoyo: un cliente de MySQL y uno de PostgreSQL que se quedan
# encendidos mientras corre el script, para no crear uno por cada consulta.
limpiar_clientes
docker run -d --rm --name "$CLIENTE_MYSQL" --entrypoint sleep mysql:8.0 3600 >/dev/null \
  || fallar "No se pudo crear el cliente de MySQL (imagen mysql:8.0)."
docker run -d --rm --name "$CLIENTE_PG" --entrypoint sleep postgres:16 3600 >/dev/null \
  || fallar "No se pudo crear el cliente de PostgreSQL (imagen postgres:16)."

mysql_q() {  # mysql_q <ip> <sql>
  docker exec -e MYSQL_PWD "$CLIENTE_MYSQL" mysql -uroot -h "$1" --connect-timeout=5 -N -B -e "$2" 2>/dev/null
}
pg_q() {     # pg_q <ip> <sql>
  docker exec -e PGPASSWORD "$CLIENTE_PG" psql -h "$1" -U postgres -d boletera -At -c "$2" 2>/dev/null
}
mongo_q() {  # mongo_q <host> <puerto> <js>: usa el mongosh de mongo-cfg-pc1
  docker exec mongo-cfg-pc1 mongosh --quiet --host "$1" --port "$2" --eval "$3" 2>/dev/null
}
nombre_de() { case "$1" in "$PC1_IP") echo pc1 ;; "$PC2_IP") echo pc2 ;; "$PC3_IP") echo pc3 ;; esac; }

# =================================================================================
titulo "2. Contenedores de PC1"

ANTES=$(docker ps --format '{{.Names}}')
for f in $COMPOSE_PC1; do
  for c in $(awk '/container_name:/{print $2}' "infra/pc1/$f.yml"); do
    if echo "$ANTES" | grep -qx "$c"; then
      ok "$c ya estaba corriendo"
    elif [ "$REVISAR" = 1 ]; then
      aviso "$c está apagado"
    else
      docker compose -f "infra/pc1/$f.yml" up -d >/dev/null 2>&1 \
        || fallar "No se pudo encender infra/pc1/$f.yml." "Prueba a mano: docker compose -f infra/pc1/$f.yml up -d"
      registrar "detener $c|docker stop $c"
      ok "$c encendido"
    fi
  done
done

sano() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
for c in mysql-pc1 mongo-cfg-pc1 mongo-shard-a-pc1 mongo-shard-b-pc1; do
  esperar "$T_LOCAL" "$c healthy" sano "$c" || critico "$c no llegó a healthy." "Mira: docker logs $c --tail 50"
done
ok "MySQL y Mongo de PC1 healthy"

# =================================================================================
titulo "3. pc2 y pc3"

responde_mysql() { [ "$(mysql_q "$1" 'SELECT 1')" = 1 ]; }
responde_pg() { docker exec "$CLIENTE_PG" pg_isready -h "$1" -U postgres -t 3; }
responde_mongo() { [ "$(mongo_q "$1" "$2" 'db.adminCommand({ping:1}).ok')" = 1 ]; }

for par in "pc2 $PC2_IP" "pc3 $PC3_IP"; do
  set -- $par
  pista="En $1 (PowerShell, en la carpeta del repo): docker compose -f infra\\$1\\mysql.yml up -d; docker compose -f infra\\$1\\mongo.yml up -d; docker compose -f infra\\$1\\postgres.yml up -d"
  esperar "$T_REMOTO" "MySQL de $1" responde_mysql "$2" || critico "MySQL de $1 no responde." "$pista"
  esperar "$T_REMOTO" "PostgreSQL de $1" responde_pg "$2" || critico "PostgreSQL de $1 no responde." "$pista"
  for puerto in 27019 27018 27020; do
    esperar "$T_REMOTO" "Mongo de $1, puerto $puerto" responde_mongo "$1" "$puerto" \
      || critico "Mongo de $1 (puerto $puerto) no responde." "$pista"
  done
  ok "$1 responde en MySQL, PostgreSQL y Mongo"
done

# =================================================================================
titulo "4. Grupo de MySQL"

estado_mysql() {  # imprime "ONLINE PRIMARY", "ONLINE SECONDARY", "RECOVERING ...", "OFFLINE"
  mysql_q "$1" "SELECT IFNULL((SELECT CONCAT(MEMBER_STATE,' ',MEMBER_ROLE) FROM performance_schema.replication_group_members WHERE MEMBER_ID=@@server_uuid AND MEMBER_STATE<>'OFFLINE'),'OFFLINE')"
}
online() { estado_mysql "$1" | grep -q '^ONLINE'; }
gtid() { mysql_q "$1" "SELECT REPLACE(@@GLOBAL.gtid_executed, '\n', '')"; }

NODOS="$PC1_IP $PC2_IP $PC3_IP"
PRIMARIO=''; HAY_GRUPO=''
for ip in $NODOS; do
  e=$(estado_mysql "$ip")
  echo "  $(nombre_de "$ip"): ${e:-sin respuesta}"
  [ "$e" = "ONLINE PRIMARY" ] && PRIMARIO=$ip
  # ERROR es un nodo que el grupo sacó: no cuenta como grupo
  case "$e" in OFFLINE|ERROR*|'') ;; *) HAY_GRUPO=$ip ;; esac
done

# Un nodo ONLINE o RECOVERING sin primario es un grupo eligiendo: se espera, nunca
# se arranca otro grupo encima (quedarían dos grupos con datos distintos).
if [ -z "$PRIMARIO" ] && [ -n "$HAY_GRUPO" ]; then
  hay_primario() { mysql_q "$HAY_GRUPO" "SELECT MEMBER_HOST FROM performance_schema.replication_group_members WHERE MEMBER_ROLE='PRIMARY' AND MEMBER_STATE='ONLINE'" | grep -q .; }
  esperar "$T_GRUPO" "el grupo elige primario" hay_primario || critico "El grupo de MySQL existe pero no tiene primario."
  for ip in $NODOS; do [ "$(estado_mysql "$ip")" = "ONLINE PRIMARY" ] && PRIMARIO=$ip; done
fi

if [ -z "$PRIMARIO" ] && [ -z "$HAY_GRUPO" ] && [ "$REVISAR" = 0 ]; then
  # El grupo se arranca en el nodo cuyos datos (GTID) contienen a los de los otros
  # dos. Si se arrancara en uno atrasado, los otros no podrían unirse.
  for candidato in $PC1_IP $PC2_IP $PC3_IP; do
    g=$(gtid "$candidato")
    contiene=1
    for otro in $NODOS; do
      [ "$otro" = "$candidato" ] && continue
      go=$(gtid "$otro")
      [ "$(mysql_q "$candidato" "SELECT GTID_SUBSET('$go', '$g')")" = 1 ] || contiene=0
    done
    if [ "$contiene" = 1 ]; then PRIMARIO=$candidato; break; fi
  done
  [ -n "$PRIMARIO" ] || fallar "Ningún nodo de MySQL tiene todos los datos de los otros." \
    "Los nodos se separaron. Compara SELECT @@GLOBAL.gtid_executed; en los tres y decide a mano."
  n=$(nombre_de "$PRIMARIO")
  echo "  Se arranca el grupo en $n (tiene todos los datos)"
  mysql_q "$PRIMARIO" "SET GLOBAL group_replication_bootstrap_group=ON; START GROUP_REPLICATION;" >/dev/null
  mysql_q "$PRIMARIO" "SET GLOBAL group_replication_bootstrap_group=OFF;" >/dev/null
  registrar "sacar a $n del grupo de MySQL|mysql_q $PRIMARIO 'STOP GROUP_REPLICATION'"
  esperar "$T_GRUPO" "$n como PRIMARY" online "$PRIMARIO" || fallar "No se pudo arrancar el grupo en $n."
  ok "Grupo arrancado en $n"
elif [ -n "$PRIMARIO" ]; then
  ok "Ya hay un primario: $(nombre_de "$PRIMARIO")"
fi

if [ "$REVISAR" = 0 ] && [ -n "$PRIMARIO" ]; then
  for ip in $NODOS; do
    online "$ip" && continue
    n=$(nombre_de "$ip")
    # Un nodo con transacciones que el grupo no tiene no puede entrar, y forzarlo
    # dejaría datos distintos. Se avisa y se repara a mano.
    extra=$(mysql_q "$PRIMARIO" "SELECT GTID_SUBTRACT('$(gtid "$ip")', @@GLOBAL.gtid_executed)")
    if [ -n "$extra" ]; then
      aviso "$n tiene transacciones que el grupo no tiene ($extra); no se une. No lo fuerces: compara CHECKSUM TABLE en los nodos y repáralo a mano."
      continue
    fi
    echo "  Uniendo $n al grupo (se pone al día con lo que le falta; puede tardar)"
    # Un nodo en ERROR primero se detiene; en uno OFFLINE no hace nada.
    # START GROUP_REPLICATION espera a que el nodo entre; el error se revisa abajo
    mysql_q "$ip" "STOP GROUP_REPLICATION;" >/dev/null
    mysql_q "$ip" "START GROUP_REPLICATION;" >/dev/null
    registrar "sacar a $n del grupo de MySQL|mysql_q $ip 'STOP GROUP_REPLICATION'"
    if esperar "$T_GRUPO" "$n ONLINE" online "$ip"; then
      ok "$n se unió"
    else
      aviso "$n no pudo unirse. Mira: docker logs mysql-$n --tail 50 (en $n)"
    fi
  done
fi

EN_LINEA=0
for ip in $NODOS; do online "$ip" && EN_LINEA=$((EN_LINEA + 1)); done
[ "$EN_LINEA" -ge 2 ] || critico "El grupo de MySQL tiene $EN_LINEA nodo(s) ONLINE; se necesitan al menos 2."
[ "$EN_LINEA" = 3 ] && ok "MySQL: 3 de 3 nodos ONLINE" \
  || aviso "MySQL: $EN_LINEA de 3 nodos ONLINE. Funciona, pero no hagas pruebas de caída de MySQL."

# Mismos datos en los nodos ONLINE: huella de cada tabla y transacciones aplicadas.
# Se repite unas veces porque una escritura en camino cambia la huella un momento.
TABLAS="boletera.clientes_contacto, boletera.clientes_facturacion, boletera.ordenes, boletera.orden_detalle, boletera.pagos, boletera.boletos"
huella_mysql() { echo "$(mysql_q "$1" "CHECKSUM TABLE $TABLAS" | awk '{printf "%s ", $2}')$(gtid "$1")"; }
mismos_datos() {
  local ref='' h ip
  for ip in $NODOS; do
    online "$ip" || continue
    h=$(huella_mysql "$ip")
    [ -z "$ref" ] && ref=$h
    [ "$h" = "$ref" ] || return 1
  done
}
if esperar 15 "huellas iguales en los nodos de MySQL" mismos_datos; then
  ok "Los nodos ONLINE de MySQL tienen los mismos datos"
else
  aviso "Las huellas de MySQL no coinciden entre nodos. Compara: CHECKSUM TABLE $TABLAS; en cada uno."
fi

# =================================================================================
titulo "5. PostgreSQL"

PG_PRIM=$PC2_IP; PG_REPL=$PC3_IP
R2=$(pg_q "$PC2_IP" 'SELECT pg_is_in_recovery()')
R3=$(pg_q "$PC3_IP" 'SELECT pg_is_in_recovery()')
case "$R2$R3" in
  ft) PG_PRIM=$PC2_IP; PG_REPL=$PC3_IP ;;
  tf) PG_PRIM=$PC3_IP; PG_REPL=$PC2_IP; aviso "El primario de PostgreSQL es pc3 (se promovió antes)." ;;
  ff) critico "pc2 y pc3 dicen ser primario de PostgreSQL." \
        "Hay que reconstruir el viejo como réplica: docs/replicacion-postgres.md, 'Regresar el viejo primario como réplica'." ;;
  *)  critico "No hay primario de PostgreSQL (pc2: ${R2:-?}, pc3: ${R3:-?})." \
        "Si pc2 no va a volver: docker exec postgres-pc3 psql -U postgres -c \"SELECT pg_promote();\" (en pc3)" ;;
esac
ok "Primario: $(nombre_de "$PG_PRIM"); réplica: $(nombre_de "$PG_REPL")"

en_streaming() { [ "$(pg_q "$PG_PRIM" "SELECT count(*) FROM pg_stat_replication WHERE state='streaming'")" -ge 1 ]; }
if esperar "$T_PG" "réplica en streaming" en_streaming; then
  ok "La réplica recibe los cambios"
else
  aviso "La réplica no está en streaming. Las compras funcionan, pero no se está copiando. Mira: docker logs postgres-$(nombre_de "$PG_REPL") --tail 50"
fi

# =================================================================================
titulo "6. MongoDB"

tiene_primario() { [ "$(docker exec "$1" mongosh --quiet --port "$2" --eval 'rs.status().members.filter(m => m.stateStr === "PRIMARY").length' 2>/dev/null)" = 1 ]; }
for par in "cfgRS mongo-cfg-pc1 27019" "shardA mongo-shard-a-pc1 27018" "shardB mongo-shard-b-pc1 27020"; do
  set -- $par
  esperar "$T_MONGO" "$1 con primario" tiene_primario "$2" "$3" || critico "$1 no tiene primario." \
    "Necesita 2 de sus 3 miembros encendidos. Mira: docker exec -it $2 mongosh --port $3 --eval 'rs.status()'"
  ok "$1 tiene primario"
done

esperar "$T_LOCAL" "mongos-pc1 healthy" sano mongos-pc1 || critico "mongos-pc1 no llegó a healthy." "Mira: docker logs mongos-pc1 --tail 50"
ok "mongos de pc1 responde"
if responde_mongo pc2 27017; then ok "mongos de pc2 responde"
else aviso "mongos de pc2 no responde; la API sigue por el de pc1. En pc2: docker compose -f infra\\pc2\\mongo.yml up -d"
fi

# =================================================================================
titulo "7. Monitoreo"

UP_JSON=$(mktemp)
if curl -s --max-time 5 'http://localhost:9090/api/v1/query?query=up' -o "$UP_JSON" 2>/dev/null; then
  arriba=$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["data"]["result"]; print(sum(x["value"][1]=="1" for x in r), len(r))' "$UP_JSON" 2>/dev/null)
  rm -f "$UP_JSON"
  set -- $arriba
  if [ "${1:-0}" = "${2:-x}" ]; then ok "Prometheus: $1 de $2 servicios UP"
  else aviso "Prometheus: ${1:-?} de ${2:-?} servicios UP. Revisa http://pc1:9090/targets (los exporters tardan unos segundos)."
  fi
else
  aviso "Prometheus no responde en el puerto 9090."
fi

# =================================================================================
titulo "8. API"

salud() { curl -s --max-time 4 http://localhost:4000/health; }
salud_ok() { [ "$(salud)" = '{"mysql":"ok","postgres":"ok","mongo":"ok"}' ]; }

if salud >/dev/null 2>&1 && [ -n "$(salud)" ]; then
  if salud_ok; then ok "La API ya estaba corriendo y responde ok"
  else aviso "La API ya estaba corriendo pero responde: $(salud)"
  fi
elif [ "$REVISAR" = 1 ] || [ "$SIN_API" = 1 ]; then
  aviso "La API no está corriendo"
else
  mkdir -p "$LOG_DIR"
  if [ ! -d api/node_modules ]; then
    echo "  Instalando dependencias de la API"
    (cd api && npm install --silent) || fallar "npm install falló en api/."
  fi
  # Lo mismo que npm start, pero así el PID guardado es el de la API misma
  (cd api && nohup node --env-file=.env src/index.js >> "$LOG_API" 2>&1 & echo $! > "$PID_API")
  registrar "apagar la API|kill \$(cat '$PID_API'); rm -f '$PID_API'"
  esperar "$T_API" "/health con los tres en ok" salud_ok \
    || fallar "La API no respondió ok: $(salud)" "Mira el registro: tail -50 logs/api.log"
  ok "API encendida (registro en logs/api.log)"
fi

# =================================================================================
titulo "Resumen"
if [ "$AVISOS" = 0 ]; then
  verde "Todo arriba y sin avisos."
else
  amarillo "Todo lo indispensable está arriba, con $AVISOS aviso(s) (en amarillo arriba)."
fi
cat <<FIN

  API:        http://pc1:4000/health
  Prometheus: http://pc1:9090/targets
  Grafana:    http://pc1:3000   (tablero "Boletera - Resumen")
  Registro de la API, en vivo:   tail -f logs/api.log
  Apagar la API:                 kill \$(cat logs/api.pid)
FIN
