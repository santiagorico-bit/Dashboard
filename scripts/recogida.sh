#!/usr/bin/env bash
# Recogida completa: FitnessKPI + Lead 2.0 + Resamania.
# La lanza launchd cada 5 minutos, pero también sirve para ejecutarla a mano.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
mkdir -p artifacts/logs

# Credenciales del correo de aviso, si están configuradas.
# Copia scripts/entorno.sh.ejemplo a scripts/entorno.sh y rellénalo.
# shellcheck source=/dev/null
[ -f scripts/entorno.sh ] && . scripts/entorno.sh

LOG=artifacts/logs/recogida.log
# Evita que el registro crezca sin límite: 288 pasadas al día se acumulan.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then
  mv -f "$LOG" artifacts/logs/recogida.anterior.log
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- inicio" >> "$LOG"
node src/collect-all.js >> "$LOG" 2>&1
CODIGO=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- fin (codigo $CODIGO)" >> "$LOG"
exit $CODIGO
