#!/bin/bash
# Prepara una Mac para la red de Boletera (sirve para cualquier PC que sea Mac):
#
#   1. Revisa que la IP de esta Mac sea la que se dice (la IP fija se configura
#      antes; ver docs/arranque-red.md).
#   2. Agrega pc1, pc2 y pc3 a /etc/hosts, para que la API, los seeds y los
#      comandos de esta Mac encuentren a las otras por nombre.
#   3. Revisa el firewall de macOS. No se abren puertos uno por uno como en
#      Windows: el firewall de macOS deja pasar o bloquea por aplicacion. Si esta
#      encendido, se permite a Docker Desktop recibir conexiones.
#
# Uso, desde la raiz del repo (pide la clave de la Mac para sudo):
#
#   bash infra/red/preparar-red-mac.sh --pc 1 --pc1 192.168.1.101 --pc2 192.168.1.102 --pc3 192.168.1.103
#
# Con --solo-mostrar dice lo que haria sin cambiar nada. Se puede volver a correr:
# reemplaza sus propias lineas de /etc/hosts. Para quitarlas: --quitar.
#
# Escrito para el bash 3.2 que trae macOS.
set -euo pipefail

MARCA='# boletera'
HOSTS=/etc/hosts
FIREWALL=/usr/libexec/ApplicationFirewall/socketfilterfw
DOCKER_BACKEND=/Applications/Docker.app/Contents/MacOS/com.docker.backend

PC=''; PC1=''; PC2=''; PC3=''; SOLO_MOSTRAR=0; QUITAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pc) PC="$2"; shift 2 ;;
    --pc1) PC1="$2"; shift 2 ;;
    --pc2) PC2="$2"; shift 2 ;;
    --pc3) PC3="$2"; shift 2 ;;
    --solo-mostrar) SOLO_MOSTRAR=1; shift ;;
    --quitar) QUITAR=1; shift ;;
    *) echo "Opcion desconocida: $1"; exit 1 ;;
  esac
done

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
amarillo() { printf '\033[33m%s\033[0m\n' "$1"; }
rojo() { printf '\033[31m%s\033[0m\n' "$1"; }

# Escribe /etc/hosts sin las lineas de este script (y con las nuevas, si se dan)
reescribir_hosts() {
  local temporal
  temporal=$(mktemp)
  grep -v "$MARCA\$" "$HOSTS" > "$temporal" || true
  if [ $# -gt 0 ]; then printf '%s\n' "$@" >> "$temporal"; fi
  sudo cp "$temporal" "$HOSTS"
  rm -f "$temporal"
  # Que macOS olvide los nombres que tenia guardados
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder 2>/dev/null || true
}

# --- Quitar ---------------------------------------------------------------------
if [ "$QUITAR" = 1 ]; then
  echo "Lineas de $HOSTS con '$MARCA': $(grep -c "$MARCA\$" "$HOSTS" || true)"
  if [ "$SOLO_MOSTRAR" = 0 ]; then
    reescribir_hosts
    verde 'Quitadas.'
  fi
  exit 0
fi

case "$PC" in 1|2|3) ;; *) rojo 'Falta --pc 1, 2 o 3 (que PC es esta Mac).'; exit 1 ;; esac
for par in "1:$PC1" "2:$PC2" "3:$PC3"; do
  n=${par%%:*}; ip=${par#*:}
  if ! printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    rojo "Falta o no es valida la IP de PC$n (--pc$n)."; exit 1
  fi
done
case "$PC" in 1) MI_IP=$PC1 ;; 2) MI_IP=$PC2 ;; 3) MI_IP=$PC3 ;; esac

# --- 1. IP ----------------------------------------------------------------------
PROPIAS=$(ifconfig | awk '/inet / && $2 != "127.0.0.1" {print $2}')
if printf '%s\n' "$PROPIAS" | grep -qx "$MI_IP"; then
  verde "OK  Esta Mac tiene la IP $MI_IP (PC$PC)."
else
  amarillo "OJO Esta Mac no tiene la IP $MI_IP. Sus IPs son: $(printf '%s' "$PROPIAS" | tr '\n' ' ')"
  amarillo '    Revisa la IP fija antes de seguir: las otras PCs la buscaran en esa direccion.'
fi

# --- 2. /etc/hosts --------------------------------------------------------------
AJENAS=$(grep -v "$MARCA\$" "$HOSTS" | grep -E '^[[:space:]]*[^#[:space:]]+[[:space:]]+(pc1|pc2|pc3)([[:space:]]|$)' || true)
if [ -n "$AJENAS" ]; then
  amarillo 'OJO /etc/hosts ya tiene estas lineas para pc1/pc2/pc3 (no son de este script):'
  printf '%s\n' "$AJENAS" | sed 's/^/    /'
  amarillo '    macOS usa la primera que encuentra. Borralas a mano si apuntan a otra IP.'
fi
L1=$(printf '%s\tpc1\t%s' "$PC1" "$MARCA")
L2=$(printf '%s\tpc2\t%s' "$PC2" "$MARCA")
L3=$(printf '%s\tpc3\t%s' "$PC3" "$MARCA")
echo
echo "$HOSTS:"
printf '    %s\n' "$L1" "$L2" "$L3"
if [ "$SOLO_MOSTRAR" = 0 ]; then
  reescribir_hosts "$L1" "$L2" "$L3"
  verde 'OK  /etc/hosts actualizado.'
fi

# --- 3. Firewall de macOS -------------------------------------------------------
echo
echo 'Puertos que reciben conexiones de las otras PCs en esta Mac:'
echo '    3306, 33061 MySQL | 5432 PostgreSQL | 27018-27020 MongoDB | 9104, 9187, 9216, 9217 exporters'
[ "$PC" != 3 ] && echo '    27017 mongos'
[ "$PC" = 1 ] && echo '    9100 node_exporter | 9090 Prometheus | 3000 Grafana | 4000 API'
ESTADO=$("$FIREWALL" --getglobalstate 2>/dev/null || echo 'desconocido')
BLOQUEO=$("$FIREWALL" --getblockall 2>/dev/null || echo '')
if printf '%s' "$ESTADO" | grep -qi 'disabled\|state = 0'; then
  verde 'OK  El firewall de macOS esta apagado: no bloquea nada.'
else
  echo "Firewall de macOS: $ESTADO"
  if printf '%s' "$BLOQUEO" | grep -qi 'enabled'; then
    amarillo 'OJO "Bloquear todas las conexiones entrantes" esta activado: ninguna otra PC podra conectarse.'
    amarillo "    Para quitarlo: sudo $FIREWALL --setblockall off"
  fi
  if [ -e "$DOCKER_BACKEND" ]; then
    echo "Se permite a Docker Desktop recibir conexiones ($DOCKER_BACKEND)."
    if [ "$SOLO_MOSTRAR" = 0 ]; then
      sudo "$FIREWALL" --add "$DOCKER_BACKEND" >/dev/null
      sudo "$FIREWALL" --unblockapp "$DOCKER_BACKEND" >/dev/null
      verde 'OK  Docker Desktop permitido en el firewall.'
    fi
  else
    amarillo "OJO No se encontro $DOCKER_BACKEND. Si Docker Desktop esta en otro lugar, permitelo en"
    amarillo '    Ajustes del Sistema > Red > Firewall > Opciones.'
  fi
fi

[ "$SOLO_MOSTRAR" = 1 ] && printf '\n\033[36m%s\033[0m\n' 'Modo --solo-mostrar: no se cambio nada.'
echo
echo "Para comprobar desde otra PC (Mac): nc -vz pc$PC 3306"
echo "Para comprobar desde otra PC (Windows): Test-NetConnection pc$PC -Port 3306"
echo 'Durante la prueba, para que la Mac no se duerma: caffeinate -dims (Ctrl+C para terminar)'
