#!/usr/bin/env bash
# Sirve el dashboard. Lo arranca launchd al iniciar sesión.
# El primer argumento elige la interfaz: 0.0.0.0 lo hace visible desde el móvil
# y otros equipos de la red; 127.0.0.1 lo limita a este ordenador.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
mkdir -p artifacts/logs

export HOST="${1:-${HOST:-0.0.0.0}}"

LOG=artifacts/logs/servidor.log
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then
  mv -f "$LOG" artifacts/logs/servidor.anterior.log
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- arranque en HOST=$HOST" >> "$LOG"
exec node dashboard/server.js >> "$LOG" 2>&1
