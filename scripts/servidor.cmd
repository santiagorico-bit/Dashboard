@echo off
REM Sirve el dashboard. Lo arranca la tarea programada al iniciar sesión.
REM HOST=0.0.0.0 lo hace visible desde el móvil y otros equipos de la red;
REM pon HOST=127.0.0.1 si prefieres que sólo se vea en este ordenador.

cd /d "%~dp0.."
if not exist "artifacts\logs" mkdir "artifacts\logs"
REM Primer argumento gana; si no, la variable de entorno; si no, la red local.
if not "%~1"=="" set HOST=%~1
if "%HOST%"=="" set HOST=0.0.0.0

for %%A in ("artifacts\logs\servidor.log") do if %%~zA GTR 5000000 move /y "artifacts\logs\servidor.log" "artifacts\logs\servidor.anterior.log" >nul

echo [%date% %time%] --- arranque en HOST=%HOST% >> "artifacts\logs\servidor.log"
node dashboard\server.js >> "artifacts\logs\servidor.log" 2>&1
