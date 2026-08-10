@echo off
REM Recogida completa: FitnessKPI + Lead 2.0 + Resamania.
REM Lo lanza la tarea programada cada 5 minutos, pero también funciona
REM con doble clic para comprobar que todo está bien.

cd /d "%~dp0.."
if not exist "artifacts\logs" mkdir "artifacts\logs"

REM Credenciales del correo de aviso, si están configuradas.
REM Copia scripts\entorno.cmd.ejemplo a scripts\entorno.cmd y rellénalo.
if exist "scripts\entorno.cmd" call "scripts\entorno.cmd"

REM Evita que el registro crezca sin límite: 288 pasadas al día se acumulan.
for %%A in ("artifacts\logs\recogida.log") do if %%~zA GTR 5000000 move /y "artifacts\logs\recogida.log" "artifacts\logs\recogida.anterior.log" >nul

echo [%date% %time%] --- inicio >> "artifacts\logs\recogida.log"
node src\collect-all.js >> "artifacts\logs\recogida.log" 2>&1
echo [%date% %time%] --- fin (codigo %errorlevel%) >> "artifacts\logs\recogida.log"
exit /b %errorlevel%
