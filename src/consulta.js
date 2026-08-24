#!/usr/bin/env node
/**
 * Consulta puntual de datos de Resamania para cualquier centro.
 *
 *   node src/consulta.js ruzafa altas --mes
 *   node src/consulta.js madrid bajas --desde 2026-08-01 --hasta 2026-08-10
 *   node src/consulta.js les-arts incidencias
 *   node src/consulta.js nuevo-centro contacto "garcia" --json
 *
 * Las reglas de clasificación son las mismas que usa el dashboard, así que las
 * cifras coinciden. Con --json la salida es apta para otro programa.
 */

import { CONSULTAS, NOMBRES_CONSULTA } from "./consulta-queries.js";
import { CLUB_SLUGS, openClubSession, resolveClub } from "./resamania-browser.js";
import { SessionExpiredError } from "./resamania-session.js";

const HOY = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Traduce los argumentos a una consulta concreta. Puro: se prueba sin red. */
export function parseArgs(argv, { hoy = HOY() } = {}) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const nombre = arg.slice(2);
    if (["hoy", "mes", "json", "ver"].includes(nombre)) { flags[nombre] = true; continue; }
    flags[nombre] = argv[i + 1];
    i += 1;
  }

  const [clubInput, consultaInput, ...resto] = positional;
  if (!clubInput || !consultaInput) {
    return { error: `Uso: node src/consulta.js <centro> <${NOMBRES_CONSULTA.join("|")}> [opciones]` };
  }

  const club = resolveClub(clubInput);
  if (!club) {
    return { error: `Centro no reconocido: "${clubInput}". Opciones: ${CLUB_SLUGS.join(", ")}` };
  }

  const consulta = consultaInput.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!CONSULTAS[consulta]) {
    return { error: `Consulta no reconocida: "${consultaInput}". Opciones: ${NOMBRES_CONSULTA.join(", ")}` };
  }

  const inicioDeMes = `${hoy.slice(0, 8)}01`;
  let desde = flags.desde ?? (flags.hoy ? hoy : inicioDeMes);
  let hasta = flags.hasta ?? hoy;
  if (flags.hoy) { desde = hoy; hasta = hoy; }

  for (const [etiqueta, valor] of [["--desde", desde], ["--hasta", hasta]]) {
    if (!ES_FECHA.test(valor)) return { error: `${etiqueta} debe tener formato AAAA-MM-DD (recibido: "${valor}")` };
  }
  if (desde > hasta) return { error: `El rango está invertido: --desde ${desde} es posterior a --hasta ${hasta}` };

  return {
    club,
    consulta,
    opciones: { from: desde, to: hasta, termino: resto.join(" ") || flags.termino },
    json: flags.json === true,
    verNavegador: flags.ver === true,
  };
}

/** Presentación legible; con --json se imprime el objeto tal cual. */
export function formatear(resultado, club) {
  const lineas = [`${club.name} · ${resultado.periodo?.desde ?? ""} → ${resultado.periodo?.hasta ?? ""}`, ""];
  const punto = (etiqueta, valor) => `  ${etiqueta.padEnd(28)} ${valor}`;

  switch (resultado.consulta) {
    case "altas":
      lineas.push(punto("Altas", resultado.total), punto("Personas distintas", resultado.personas));
      break;
    case "bajas":
      lineas.push(punto("Bajas", resultado.total));
      break;
    case "activos":
      lineas.push(punto("Socios activos", resultado.total));
      break;
    case "facturacion":
      lineas.push(
        punto("Facturación", `${resultado.total.toLocaleString("es-ES", { style: "currency", currency: "EUR" })}`),
        punto("Facturas válidas", resultado.facturas),
        punto("Descartadas", resultado.descartadas),
      );
      break;
    case "incidencias": {
      const detalle = (estados) => Object.entries(estados)
        .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(" · ") || "ninguna";
      lineas.push(
        punto("Incidencias de pago", resultado.pago.total),
        `      ${detalle(resultado.pago.estados)}`,
        punto("Contratos no formalizados", resultado.contratosNoFormalizados.total),
        `      ${detalle(resultado.contratosNoFormalizados.estados)}`,
      );
      break;
    }
    case "contacto":
      lineas.push(punto("Coincidencias", resultado.total));
      for (const fila of resultado.resultados) lineas.push(`      ${fila.nombre ?? "(sin nombre)"} · ${fila.email ?? "sin correo"}`);
      break;
    case "resumen":
      lineas.push(
        punto("Altas", resultado.altas),
        punto("Bajas", resultado.bajas),
        punto("Socios activos", resultado.activos),
        punto("Incidencias de pago", resultado.incidenciasDePago),
        punto("Contratos no formalizados", resultado.contratosNoFormalizados),
      );
      break;
    default:
      lineas.push(JSON.stringify(resultado, null, 2));
  }
  return lineas.join("\n");
}

// Sólo actúa cuando se ejecuta directamente: importarlo no consulta nada.
const ejecutadoDirectamente = process.argv[1]
  && import.meta.url === `file://${process.argv[1]}`;

if (ejecutadoDirectamente) {
  const plan = parseArgs(process.argv.slice(2));
  if (plan.error) {
    console.error(plan.error);
    process.exit(2);
  }

  let sesion;
  try {
    sesion = await openClubSession(plan.club.slug, { headless: !plan.verNavegador });
    const resultado = await CONSULTAS[plan.consulta](sesion.api, {
      clubId: sesion.clubId,
      ...plan.opciones,
    });
    console.log(plan.json ? JSON.stringify(resultado, null, 2) : formatear(resultado, plan.club));
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      console.error(`\n${error.message}`);
      process.exit(3);
    }
    console.error(`\nLa consulta falló: ${error.message}`);
    process.exit(1);
  } finally {
    await sesion?.close();
  }
}
