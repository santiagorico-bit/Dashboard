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
- **Reautenticación**: alguien ejecuta `npm run setup:club` cuando el dashboard
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

## Si se elige A

Queda por hacer:

1. Una tarea programada que ejecute `node src/collect-all.js` cada X minutos.
2. Que el dashboard arranque solo al encender el equipo, con `HOST=0.0.0.0`.
3. Decidir si el aviso de sesión caducada debe llegar por algún medio además del
   propio dashboard (correo, por ejemplo), para no depender de que alguien lo
   esté mirando.

El punto 3 es el que más rendimiento da: sin él, una sesión caída de viernes por
la tarde no se detecta hasta el lunes.
