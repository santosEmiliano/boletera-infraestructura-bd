<#
Prepara una PC Windows para la red de Boletera (para una Mac:
infra/red/preparar-red-mac.sh):

  1. Revisa que la IP de esta PC sea la que se dice (la IP fija se configura antes,
     en el router o en el adaptador; ver docs/arranque-red.md).
  2. Agrega pc1, pc2 y pc3 al archivo hosts, para que la API, los seeds y los
     comandos de esta PC encuentren a las otras por nombre.
  3. Abre en el firewall solo los puertos de los servicios de esta PC, solo para
     la red local y solo en el perfil Privado.
  4. Avisa si la red esta marcada como Publica (con eso el firewall bloquea todo).

Uso, en PowerShell como administrador y desde la raiz del repo:

  powershell -ExecutionPolicy Bypass -File infra\red\preparar-red-windows.ps1 -Pc 2 -Pc1Ip 192.168.1.101 -Pc2Ip 192.168.1.102 -Pc3Ip 192.168.1.103

Con -SoloMostrar dice lo que haria sin cambiar nada (no necesita administrador).
Se puede volver a correr: reemplaza sus propias entradas de hosts y sus reglas
(grupo "Boletera" en el firewall). Para quitarlo todo: -Quitar.

El archivo va sin acentos a proposito: PowerShell 5.1 lee los .ps1 sin BOM como
ANSI y los acentos saldrian mal.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet(1, 2, 3)][int]$Pc,
  [string]$Pc1Ip,
  [string]$Pc2Ip,
  [string]$Pc3Ip,
  [switch]$SoloMostrar,
  [switch]$Quitar
)

$ErrorActionPreference = 'Stop'
$GRUPO = 'Boletera'
$MARCA = '# boletera'
$HOSTS = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'

# Puertos que reciben conexiones de las otras PCs. Salen de infra/pcX/*.yml y
# de infra/monitoring/prometheus.yml.
# Las llaves van como texto: en un [ordered] un numero entre corchetes se toma
# como posicion ($PUERTOS[3306] seria el elemento 3306), no como llave.
$PUERTOS = [ordered]@{
  '3306'  = 'MySQL'
  '33061' = 'MySQL Group Replication'
  '5432'  = 'PostgreSQL'
  '27018' = 'MongoDB shardA'
  '27019' = 'MongoDB config server'
  '27020' = 'MongoDB shardB'
  '9104'  = 'mysqld_exporter'
  '9187'  = 'postgres_exporter'
  '9216'  = 'mongodb_exporter shardA'
  '9217'  = 'mongodb_exporter shardB'
  '9182'  = 'windows_exporter'
}
# mongos corre en PC1 y PC2; monitoreo y API, en PC1
if ($Pc -ne 3) { $PUERTOS['27017'] = 'mongos' }
if ($Pc -eq 1) {
  $PUERTOS['9090'] = 'Prometheus'
  $PUERTOS['3000'] = 'Grafana'
  $PUERTOS['4000'] = 'API'
  # PostgreSQL y su exporter no corren en PC1
  $PUERTOS.Remove('5432')
  $PUERTOS.Remove('9187')
}

function Escribir($texto, $color = 'Gray') { Write-Host $texto -ForegroundColor $color }

$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $SoloMostrar -and -not $esAdmin) {
  Escribir 'Hay que correrlo en una PowerShell abierta como administrador (o con -SoloMostrar).' Red
  exit 1
}

# --- Quitar todo lo que agrego este script ---------------------------------
if ($Quitar) {
  $reglas = @(Get-NetFirewallRule -Group $GRUPO -ErrorAction SilentlyContinue)
  $lineas = @(Get-Content $HOSTS | Where-Object { $_ -like "*$MARCA" })
  Escribir "Reglas de firewall del grupo '$GRUPO': $($reglas.Count)"
  Escribir "Lineas de hosts con '$MARCA': $($lineas.Count)"
  if (-not $SoloMostrar) {
    $reglas | Remove-NetFirewallRule
    Set-Content -Path $HOSTS -Encoding ASCII -Value (Get-Content $HOSTS | Where-Object { $_ -notlike "*$MARCA" })
    Escribir 'Quitado.' Green
  }
  exit 0
}

# --- 1. IPs -----------------------------------------------------------------
$ips = @{ 1 = $Pc1Ip; 2 = $Pc2Ip; 3 = $Pc3Ip }
foreach ($n in 1, 2, 3) {
  $valor = $ips[$n]
  $ip = $null
  if (-not $valor -or -not [System.Net.IPAddress]::TryParse($valor, [ref]$ip)) {
    Escribir "Falta o no es valida la IP de PC${n} (-Pc${n}Ip)." Red
    exit 1
  }
}

$propias = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' } | Select-Object -ExpandProperty IPAddress)
if ($propias -contains $ips[$Pc]) {
  Escribir "OK  Esta PC tiene la IP $($ips[$Pc]) (PC$Pc)." Green
} else {
  Escribir "OJO Esta PC no tiene la IP $($ips[$Pc]). Sus IPs son: $($propias -join ', ')." Yellow
  Escribir '    Revisa la IP fija antes de seguir: las otras PCs la buscaran en esa direccion.' Yellow
}

# --- 2. hosts ----------------------------------------------------------------
$actuales = @(Get-Content $HOSTS)
$sinLasNuestras = @($actuales | Where-Object { $_ -notlike "*$MARCA" })
$ajenas = @($sinLasNuestras | Where-Object { $_ -match '^\s*[^#\s]+\s+(pc1|pc2|pc3)(\s|$)' })
if ($ajenas.Count -gt 0) {
  Escribir 'OJO El archivo hosts ya tiene estas lineas para pc1/pc2/pc3 (no son de este script):' Yellow
  $ajenas | ForEach-Object { Escribir "    $_" Yellow }
  Escribir '    Windows usa la primera que encuentra. Borralas a mano si apuntan a otra IP.' Yellow
}
$nuevas = foreach ($n in 1, 2, 3) { "$($ips[$n])`tpc$n`t$MARCA" }
Escribir "`nArchivo hosts ($HOSTS):"
$nuevas | ForEach-Object { Escribir "    $_" }
if (-not $SoloMostrar) {
  Set-Content -Path $HOSTS -Encoding ASCII -Value ($sinLasNuestras + $nuevas)
  Escribir 'OK  hosts actualizado.' Green
}

# --- 3. Firewall -------------------------------------------------------------
Escribir "`nReglas de firewall (entrada, TCP, solo red local, perfil Privado), grupo '$GRUPO':"
foreach ($puerto in $PUERTOS.Keys) { Escribir ("    {0,-6} {1}" -f $puerto, $PUERTOS[$puerto]) }
if (-not $SoloMostrar) {
  Get-NetFirewallRule -Group $GRUPO -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($puerto in $PUERTOS.Keys) {
    New-NetFirewallRule -DisplayName "Boletera $puerto $($PUERTOS[$puerto])" -Group $GRUPO `
      -Direction Inbound -Protocol TCP -LocalPort $puerto -Action Allow `
      -Profile Private -RemoteAddress LocalSubnet | Out-Null
  }
  Escribir "OK  $($PUERTOS.Count) reglas creadas." Green
}

# --- 4. Perfil de red ----------------------------------------------------------
Escribir "`nPerfil de las redes conectadas:"
foreach ($perfil in Get-NetConnectionProfile) {
  if ($perfil.NetworkCategory -eq 'Private') {
    Escribir "OK  $($perfil.InterfaceAlias) ($($perfil.Name)): Privada" Green
  } else {
    Escribir "OJO $($perfil.InterfaceAlias) ($($perfil.Name)): $($perfil.NetworkCategory). Las reglas solo valen en Privada. Para cambiarla:" Yellow
    Escribir "    Set-NetConnectionProfile -InterfaceAlias '$($perfil.InterfaceAlias)' -NetworkCategory Private" Yellow
  }
}

if ($SoloMostrar) { Escribir "`nModo -SoloMostrar: no se cambio nada." Cyan }
Escribir "`nPara comprobar desde otra PC (Windows): Test-NetConnection pc$Pc -Port 3306"
Escribir "Para comprobar desde otra PC (Mac): nc -vz pc$Pc 3306"
