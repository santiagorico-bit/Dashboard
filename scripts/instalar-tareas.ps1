<#
.SYNOPSIS
  Programa el dashboard en Windows: recogida cada 5 minutos y arranque
  automático al iniciar sesión.

.DESCRIPTION
  Crea dos tareas programadas:

    OnAir Dashboard - Recogida  ejecuta scripts\recogida.cmd al iniciar sesión
                                y después cada 5 minutos.
    OnAir Dashboard - Servidor  ejecuta scripts\servidor.cmd al iniciar sesión.

  Las tareas corren con tu usuario y sólo cuando has iniciado sesión, porque la
  recogida abre Chrome con tu perfil: sin sesión de usuario no hay perfil que
  abrir. Volver a ejecutar este script actualiza las tareas existentes.

.PARAMETER BindHost
  Interfaz en la que escucha el dashboard. 0.0.0.0 lo hace accesible desde la
  red local; 127.0.0.1 lo limita a este equipo.

.PARAMETER Minutes
  Cada cuántos minutos se repite la recogida.

.PARAMETER Remove
  Elimina las dos tareas en lugar de crearlas.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1 -BindHost 127.0.0.1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1 -Remove
#>

[CmdletBinding()]
param(
  [string]$BindHost = "0.0.0.0",
  [int]$Minutes = 5,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$collectorTask = "OnAir Dashboard - Recogida"
$serverTask    = "OnAir Dashboard - Servidor"

if ($Remove) {
  foreach ($name in @($collectorTask, $serverTask)) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "Eliminada: $name"
    } else {
      Write-Host "No existía: $name"
    }
  }
  return
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$collectorCmd = Join-Path $PSScriptRoot "recogida.cmd"
$serverCmd    = Join-Path $PSScriptRoot "servidor.cmd"

foreach ($file in @($collectorCmd, $serverCmd)) {
  if (-not (Test-Path $file)) { throw "No se encuentra $file" }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "No se encuentra 'node' en el PATH. Instala Node.js antes de programar las tareas."
}

# Al iniciar sesión, y a partir de ahí cada N minutos de forma indefinida.
# La repetición se copia de un disparador auxiliar porque New-ScheduledTaskTrigger
# no admite -AtLogOn y -RepetitionInterval a la vez.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$logonTrigger.Repetition = $repeating.Repetition

# IgnoreNew es lo que impide que una pasada lenta se solape con la siguiente.
# El límite de dos horas corta una recogida que se haya quedado colgada.
$collectorSettings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

# El servidor es un proceso que no termina: sin límite de ejecución.
$serverSettings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

$collectorAction = New-ScheduledTaskAction -Execute $collectorCmd -WorkingDirectory $repoRoot
# El host va como argumento: una variable de entorno fijada aquí no llegaría
# al entorno en el que la tarea se ejecuta más tarde.
$serverAction = New-ScheduledTaskAction -Execute $serverCmd -Argument $BindHost -WorkingDirectory $repoRoot

Register-ScheduledTask -TaskName $collectorTask -Force `
  -Description "Recoge FitnessKPI, Lead 2.0 y Resamania cada $Minutes minutos." `
  -Trigger $logonTrigger -Settings $collectorSettings -Principal $principal -Action $collectorAction | Out-Null
Write-Host "Creada: $collectorTask (al iniciar sesión y cada $Minutes minutos)"

Register-ScheduledTask -TaskName $serverTask -Force `
  -Description "Sirve el dashboard en HOST=$BindHost." `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings $serverSettings -Principal $principal -Action $serverAction | Out-Null
Write-Host "Creada: $serverTask (al iniciar sesión, HOST=$BindHost)"

Write-Host ""
Write-Host "Registros en artifacts\logs\"
Write-Host "Para lanzar una recogida ahora:  Start-ScheduledTask -TaskName '$collectorTask'"
Write-Host "Para quitarlo todo:              .\scripts\instalar-tareas.ps1 -Remove"

if ($BindHost -ne "127.0.0.1") {
  Write-Host ""
  Write-Warning "El dashboard no pide contraseña y muestra datos de socios. Con HOST=$BindHost lo ve cualquiera en esta red."
}
