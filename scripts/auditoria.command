#!/usr/bin/env bash
# Doble clic desde el Finder para revisar cómo se están clasificando los datos.
# No entra en Resamania: lee lo que la recogida ya ha guardado.

cd "$(dirname "$0")/.." || exit 1
mkdir -p artifacts/logs

echo
echo "  Revisando cómo se están clasificando los datos..."
echo

node src/audit-classification.js 2>&1 | tee artifacts/logs/auditoria.txt
CODIGO=${PIPESTATUS[0]}

echo
echo "  ----------------------------------------------------------"
if [ "$CODIGO" -eq 0 ]; then
  echo "  Guardado en:"
  echo "    artifacts/logs/auditoria.txt"
  echo "    artifacts/auditoria-clasificacion.json"
  echo
  echo "  Puedes enviar cualquiera de los dos. No contienen datos"
  echo "  personales: sólo etiquetas de estado y recuentos."
else
  echo "  No había datos que revisar."
  echo "  Ejecuta antes una recogida (scripts/recogida.sh) y vuelve a"
  echo "  hacer doble clic aquí."
fi
echo "  ----------------------------------------------------------"
echo
read -r -p "  Pulsa Intro para cerrar."
