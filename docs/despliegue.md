# Hacer que el dashboard funcione sin depender de un PC encendido

## El obstáculo real

Todo lo demás del sistema es desplegable sin drama. La autenticación no.

Resamania no emite claves de API: la sesión se obtiene iniciando sesión en el
navegador. Por eso `src/login.js` abre Chrome, espera a que alguien complete el
acceso a mano, y guarda el resultado en un perfil persistente. El colector
después lanza ese mismo perfil y reutiliza las cabeceras de una petición real.

Eso obliga a que la máquina que recoge datos:

1. pueda ejecutar Chrome,
2. conserve el perfil entre ejecuciones,
3. y tenga a alguien que vuelva a autenticarse cuando la sesión caduque.

El punto 3 es el que impide una automatización completa. Ninguna de las opciones
de abajo lo elimina; sólo cambian con qué frecuencia molesta y a quién.

## Opción A — Un equipo siempre encendido en el club

Un PC de la oficina que no se apaga. El Programador de tareas de Windows lanza
`node src/collect-all.js` cada X minutos, y el dashboard queda servido a la red
local con `HOST=0.0.0.0`.

- **Coste**: cero, salvo la luz.
- **Datos**: no salen del local. Es lo más limpio en protección de datos.
- **Reautenticación**: alguien ejecuta `npm run setup:group` cuando el dashboard
  avisa en rojo. Con el aviso implementado, se ve en cuanto pasa.
- **Punto débil**: si ese equipo se apaga o se actualiza solo, se para todo.

## Opción B — Una máquina virtual en la nube

Lo mismo que A, pero en un servidor. Necesita entorno gráfico o Chrome headless
con un perfil creado previamente, y un acceso remoto (VNC/RDP) para el primer
inicio de sesión y para cada reautenticación.

- **Coste**: el de la VM, más el tiempo de montarla.
- **Datos**: los datos de socios salen de las instalaciones y se alojan en un
  tercero. Antes de tomar este camino hay que revisarlo con quien lleve la
  protección de datos: no es una decisión técnica.
- **Reautenticación**: igual de manual que en A, pero más incómoda, porque hay
  que entrar por escritorio remoto.
- **Punto débil**: paga y complica sin resolver el problema de fondo.

## Opción C — Pedir credenciales de servicio a Resamania

Preguntar al proveedor si ofrece acceso programático: OAuth de tipo
`client_credentials`, un usuario de servicio, o un token de larga duración.

- Si existe, **desaparece el navegador entero**. El colector pasa a ser un
  proceso normal, desplegable en cualquier sitio, sin perfiles ni Chrome ni
  reautenticaciones. El bloqueo que ha ocupado toda esta fase se evapora.
- Si no existe, al menos queda descartado y se elige A o B sabiendo por qué.

Es una conversación comercial, no una tarea de programación, y es la de mayor
retorno de las tres.

## Recomendación

**Empezar por C y montar A mientras tanto.**

A es barato, rápido y mantiene los datos en casa; cubre la necesidad desde el
primer día. C es lo único que convierte esto en un sistema realmente autónomo, y
la respuesta puede tardar semanas, así que conviene preguntar ya.

B sólo tiene sentido si no hay ningún equipo que pueda quedarse encendido y C ha
dicho que no.

## Opción A — instalación

Elegida. Se instala con un comando, desde la carpeta del proyecto:

En macOS, con `launchd`:

```bash
./scripts/instalar-tareas.sh
```

En Windows, con el Programador de tareas:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1
```

Crea dos tareas programadas con tu usuario:

| Tarea | Cuándo | Qué hace |
| --- | --- | --- |
| Recogida | al iniciar sesión, y cada 5 minutos | `recogida.sh` / `recogida.cmd` → `src/collect-all.js` |
| Servidor | al iniciar sesión | `servidor.sh` / `servidor.cmd` → dashboard en `HOST=0.0.0.0` |

Ambas corren **sólo con la sesión iniciada**, porque la recogida abre Chrome con
el perfil del usuario: sin sesión no hay perfil que abrir. Encender el equipo e
iniciar sesión dispara una recogida inmediata.

Opciones:

```bash
# macOS
./scripts/instalar-tareas.sh --host 127.0.0.1   # limitar a este equipo
./scripts/instalar-tareas.sh --minutos 10       # cambiar la frecuencia
./scripts/instalar-tareas.sh --desinstalar
```
```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1 -BindHost 127.0.0.1
powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1 -Minutes 10
powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1 -Remove
```

Los registros quedan en `artifacts\logs\`, con rotación a los 5 MB.

### Solapamiento

Una pasada de siete centros puede tardar más de cinco minutos. Hay dos frenos
independientes: la tarea está marcada como `IgnoreNew`, así que el programador
no lanza una segunda si hay una en curso; y `collect-all.js` escribe un bloqueo
en `artifacts/.collect-all.lock` que corta cualquier pasada simultánea lanzada a
mano. Sin ellos, dos procesos pelearían por el mismo perfil de Chrome y
fallarían con un error que no explica nada.

Si una recogida se queda colgada, el bloqueo se ignora a las dos horas y la
tarea se corta por límite de ejecución.

### Aviso por correo

Cuando la sesión caduca, la recogida escribe a `santiagorico@onair-fitness.es`.
Hace falta configurar el servidor de correo saliente:

```
# macOS
cp scripts/entorno.sh.ejemplo scripts/entorno.sh && open -e scripts/entorno.sh

# Windows
copy scripts\entorno.cmd.ejemplo scripts\entorno.cmd && notepad scripts\entorno.cmd
```

Ese fichero está excluido de git, así que la contraseña no se sube.
Si el proveedor de correo admite contraseñas de aplicación, conviene usar una:
se revoca sin tocar la del buzón.

Mientras no se configure, el dashboard sigue avisando en pantalla; lo único que
falta es el correo, y la recogida lo deja anotado en el registro.

**Cuándo escribe.** La recogida corre 288 veces al día: avisar en cada pasada
fallida sería un correo cada cinco minutos. Sólo escribe en los cambios de
estado —cuando cae y cuando se recupera—, más un recordatorio cada seis horas
mientras siga caída. Un día entero de caída son cuatro correos, no 288.

Un fallo al enviar el correo no interrumpe la recogida: queda anotado en
`artifacts\logs\recogida.log` y la pasada continúa.
