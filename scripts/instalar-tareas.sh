#!/usr/bin/env bash
#
# Programa el dashboard en macOS: recogida cada 5 minutos y arranque
# automático al iniciar sesión.
#
#   ./scripts/instalar-tareas.sh                  # red local (0.0.0.0)
#   ./scripts/instalar-tareas.sh --host 127.0.0.1 # sólo este ordenador
#   ./scripts/instalar-tareas.sh --minutos 10
#   ./scripts/instalar-tareas.sh --desinstalar
#
# Crea dos agentes de launchd en ~/Library/LaunchAgents. Corren con tu usuario
# y sólo con la sesión iniciada, porque la recogida abre Chrome con tu perfil:
# sin sesión no hay perfil que abrir.

set -euo pipefail

BIND_HOST="0.0.0.0"
MINUTOS=5
DESINSTALAR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) BIND_HOST="$2"; shift 2 ;;
    --minutos) MINUTOS="$2"; shift 2 ;;
    --desinstalar) DESINSTALAR=1; shift ;;
    *) echo "Opción desconocida: $1" >&2; exit 1 ;;
  esac
done

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
AGENTES="$HOME/Library/LaunchAgents"
ETIQUETA_RECOGIDA="com.onair.dashboard.recogida"
ETIQUETA_SERVIDOR="com.onair.dashboard.servidor"

descargar() {
  local etiqueta="$1"
  local plist="$AGENTES/$etiqueta.plist"
  if launchctl list "$etiqueta" >/dev/null 2>&1; then
    launchctl unload "$plist" 2>/dev/null || true
  fi
}

if [ "$DESINSTALAR" -eq 1 ]; then
  for etiqueta in "$ETIQUETA_RECOGIDA" "$ETIQUETA_SERVIDOR"; do
    descargar "$etiqueta"
    if [ -f "$AGENTES/$etiqueta.plist" ]; then
      rm -f "$AGENTES/$etiqueta.plist"
      echo "Eliminado: $etiqueta"
    else
      echo "No existía: $etiqueta"
    fi
  done
  exit 0
fi

# launchd arranca con un PATH mínimo que no incluye Homebrew ni nvm, así que
# node hay que resolverlo ahora y dejarlo escrito en el plist.
if ! NODE_BIN="$(command -v node)"; then
  echo "No se encuentra 'node' en el PATH. Instala Node.js antes de programar las tareas." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
RUTA="$NODE_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$AGENTES" "$RAIZ/artifacts/logs"
chmod +x "$RAIZ/scripts/recogida.sh" "$RAIZ/scripts/servidor.sh" "$RAIZ/scripts/auditoria.command"

escribir_plist() {
  local etiqueta="$1" programa="$2" extra="$3"
  cat > "$AGENTES/$etiqueta.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$etiqueta</string>
  <key>ProgramArguments</key>
  <array>
$programa
  </array>
  <key>WorkingDirectory</key><string>$RAIZ</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$RUTA</string>
  </dict>
  <key>RunAtLoad</key><true/>
$extra
  <key>StandardOutPath</key><string>$RAIZ/artifacts/logs/$etiqueta.out.log</string>
  <key>StandardErrorPath</key><string>$RAIZ/artifacts/logs/$etiqueta.err.log</string>
</dict>
</plist>
PLIST
}

# launchd no lanza una segunda copia de un agente que sigue corriendo, así que
# una pasada larga no se solapa con la siguiente.
escribir_plist "$ETIQUETA_RECOGIDA" \
  "    <string>$RAIZ/scripts/recogida.sh</string>" \
  "  <key>StartInterval</key><integer>$((MINUTOS * 60))</integer>"

# El servidor no termina: si se cae, launchd lo vuelve a levantar.
escribir_plist "$ETIQUETA_SERVIDOR" \
  "    <string>$RAIZ/scripts/servidor.sh</string>
    <string>$BIND_HOST</string>" \
  "  <key>KeepAlive</key><true/>"

for etiqueta in "$ETIQUETA_RECOGIDA" "$ETIQUETA_SERVIDOR"; do
  descargar "$etiqueta"
  launchctl load "$AGENTES/$etiqueta.plist"
done

echo "Creado: $ETIQUETA_RECOGIDA (al iniciar sesión y cada $MINUTOS minutos)"
echo "Creado: $ETIQUETA_SERVIDOR (al iniciar sesión, HOST=$BIND_HOST)"
echo
echo "Registros en artifacts/logs/"
echo "Para lanzar una recogida ahora:  launchctl start $ETIQUETA_RECOGIDA"
echo "Para quitarlo todo:              ./scripts/instalar-tareas.sh --desinstalar"

if [ "$BIND_HOST" != "127.0.0.1" ]; then
  echo
  echo "Aviso: el dashboard no pide contraseña y muestra datos de socios."
  echo "Con HOST=$BIND_HOST lo ve cualquiera en esta red."
fi
