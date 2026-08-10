@echo off
REM Auditoría de clasificación. Doble clic para ejecutarla.
REM Lee los datos que la recogida ya ha guardado; no entra en Resamania.

cd /d "%~dp0.."
if not exist "artifacts\logs" mkdir "artifacts\logs"

echo.
echo   Revisando como se estan clasificando los datos...
echo.

node src\audit-classification.js > "artifacts\logs\auditoria.txt" 2>&1
set CODIGO=%errorlevel%

type "artifacts\logs\auditoria.txt"

echo.
echo   ----------------------------------------------------------
if "%CODIGO%"=="0" (
  echo   Guardado en:
  echo     artifacts\logs\auditoria.txt
  echo     artifacts\auditoria-clasificacion.json
  echo.
  echo   Puedes enviar cualquiera de los dos. No contienen datos
  echo   personales: solo etiquetas de estado y recuentos.
) else (
  echo   No habia datos que revisar.
  echo   Ejecuta antes una recogida ^(scripts\recogida.cmd^) y vuelve a
  echo   hacer doble clic aqui.
)
echo   ----------------------------------------------------------
echo.
pause
