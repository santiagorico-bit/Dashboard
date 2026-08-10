# Agente Resamania

Recoge los datos de los siete centros desde Resamania, Lead 2.0 y FitnessKPI, y
los sirve en un dashboard local de solo lectura. Utiliza un navegador controlado
con perfil persistente; las credenciales no se guardan en el código.

Las métricas sin fuente verificada se muestran como `—`: nunca se sustituyen por
ceros ni estimaciones. Los ficheros de `artifacts/` pueden contener datos
personales y no deben compartirse ni versionarse.

## Primer acceso

```bash
npm install
npm run setup:group
```

Completa el acceso manualmente y pulsa Intro en la terminal cuando Resamania
esté abierto. La sesión queda guardada en el perfil del navegador y se reutiliza
en cada recogida.

## Uso diario

```bash
node src/collect-all.js   # FitnessKPI + Lead 2.0 + Resamania
npm run dashboard         # http://localhost:3000
```

Para verlo desde el móvil u otro equipo de la red, `HOST` elige la interfaz:

```powershell
$env:HOST="0.0.0.0"; npm run dashboard
```

Por defecto escucha sólo en este equipo. El dashboard no pide contraseña y
muestra datos de socios, así que abrirlo a la red es una decisión explícita.

## Automatización

Recogida cada cinco minutos y arranque al iniciar sesión:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\instalar-tareas.ps1
```

Los detalles, las opciones y las alternativas de despliegue están en
[`docs/despliegue.md`](docs/despliegue.md).

## Sesión caducada

Resamania no emite claves de API: la sesión sale del navegador y caduca cada
cierto tiempo. Cuando pasa, la API devuelve el formulario de login en lugar de
datos, y antes eso se colaba como una recogida correcta.

Ahora la recogida se detiene, el dashboard marca en rojo los centros que están
sirviendo su última captura válida, y se envía un aviso por correo. Para
recuperarla basta con `npm run setup:group`; la siguiente pasada automática la
retoma sola.

El correo se configura copiando `scripts\entorno.cmd.ejemplo` a
`scripts\entorno.cmd`, que está excluido de git.

## Incidencias

La vista de Incidencias reúne lo que requiere seguimiento manual: altas
incompletas, bajas pendientes, bajas de período completo, abonos de un mes,
bajas automáticas por gastos de devolución y dos categorías que **no descuentan
de ningún recuento**:

- **Incidencias de pago** — socios activos con el cobro pendiente o devuelto.
  Siguen contando como activos: entran al club.
- **Contratos no formalizados** — altas con la firma pendiente. Cuentan como
  alta desde el primer día, pero pueden decaer sin seguimiento, así que tienen
  recuadro propio de aviso.

En ambos casos se muestra qué estado concreto las provoca: un recibo devuelto y
un cobro sin lanzar no se resuelven igual.

## Afinar los filtros

Las reglas de `src/dashboard-domain.js` deciden qué cuenta como alta, baja o
facturación a partir de textos que devuelve Resamania. Si aparece un texto que
ninguna regla contempla, la clasificación falla en silencio.

```bash
npm run audit:clasificacion
```

En Windows también vale con hacer doble clic en `scripts\auditoria.cmd`, que
deja el resultado en `artifacts\logs\auditoria.txt`.

Lee la caché que la recogida ya ha guardado —sin llamar a la API— y lista los
estados, códigos de producto y etiquetas de oferta reales, con la clasificación
que recibe cada uno. Los estados marcados `[pago]` o `[firma]` están cubiertos;
los que salen sin marca son los que quedan por decidir. El informe sólo contiene
etiquetas y recuentos, sin datos personales.

## Tests

```bash
npm test
```
