# Agente Resamania

Prototipo local para consultar alertas de clientes mediante un navegador
controlado. Utiliza un perfil independiente y persistente; las credenciales no
se guardan en el código.

## Primer acceso

```bash
npm install
npm run login
```

Completa el acceso manualmente y pulsa Intro en la terminal cuando Resamania
esté abierto.

## Inspección inicial

```bash
npm run inspect:alerts
```

El resultado técnico se guarda dentro de `artifacts/`, que no debe publicarse
ni incorporarse a un repositorio porque puede contener datos personales.

## Dashboard consolidado

```bash
npm run dashboard
```

La interfaz queda disponible en `http://localhost:3000` y reúne los siete
centros en las vistas Resumen, Centros y Finanzas. Las métricas sin fuente
verificada se muestran como `—`; nunca se sustituyen por ceros ni estimaciones.

El dashboard funciona en modo de solo lectura y refresca su API local cada
cinco minutos. Los ficheros de `artifacts/` pueden contener datos personales y
no deben compartirse ni versionarse.
