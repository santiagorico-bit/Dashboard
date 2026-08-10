/**
 * Auditoría de clasificación.
 *
 * Las reglas de `dashboard-domain.js` deciden qué cuenta como alta, como baja y
 * como facturación a partir de textos que devuelve Resamania: nombres de oferta,
 * códigos de producto y estados. Si aparece un texto que ninguna regla
 * contempla, la suscripción se clasifica mal en silencio.
 *
 * Este script no llama a la API: lee la caché de suscripciones que el colector
 * ya ha guardado y enseña qué valores reales existen y cómo los está tratando
 * cada regla. Sirve para afinar los filtros con datos en la mano en lugar de a
 * ojo.
 *
 *   node src/audit-classification.js
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCdd, isDayPassSession, isFormulaChange, isSession, isShortPass, isTieSession,
  isPaymentIncidence, isVip, isWebOffer, normalizeState, offerLabel, productCode,
} from "./dashboard-domain.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(rootDir, "artifacts", "cache");

/** Estados que `normalizeState` sabe interpretar. */
const RECOGNISED_STATES = new Set(["canceled", "validated", "active"]);

function classify(item) {
  const labels = [];
  if (isSession(item)) labels.push("sesion");
  if (isTieSession(item)) labels.push("tie");
  if (isDayPassSession(item)) labels.push("pase-dia");
  if (isShortPass(item)) labels.push("pase-corto");
  if (isCdd(item)) labels.push("cdd");
  if (isVip(item)) labels.push("vip");
  if (isWebOffer(item)) labels.push("web");
  if (isFormulaChange(item)) labels.push("cambio-formula");
  return labels.length > 0 ? labels : ["abono"];
}

function tally(map, key, item) {
  if (!key) return;
  const entry = map.get(key) ?? { count: 0, clasificaciones: new Set() };
  entry.count += 1;
  // Un mismo código cubre varias cosas —"sesion" es TIE y pase de día—, así que
  // se guardan todas las clasificaciones vistas, no la del primer ejemplo.
  if (item) entry.clasificaciones.add(classify(item).join("+"));
  map.set(key, entry);
}

async function readCache() {
  let files;
  try {
    files = (await readdir(cacheDir)).filter((name) => /^subscriptions-.*\.json$/.test(name));
  } catch {
    return { subscriptions: [], files: [] };
  }
  const subscriptions = [];
  for (const file of files) {
    try {
      const payload = JSON.parse(await readFile(join(cacheDir, file), "utf8"));
      subscriptions.push(...Object.values(payload.subscriptions ?? {}));
    } catch (error) {
      console.error(`No se pudo leer ${file}: ${error.message}`);
    }
  }
  return { subscriptions, files };
}

const { subscriptions, files } = await readCache();

if (subscriptions.length === 0) {
  console.error(
    "No hay suscripciones en caché. Ejecuta primero una recogida (npm run collect:dashboard) " +
      "y vuelve a lanzar esta auditoría.",
  );
  process.exit(1);
}

const states = new Map();
const codes = new Map();
const offers = new Map();

for (const item of subscriptions) {
  for (const raw of [item?.status, item?.state, item?.financialState]) {
    if (raw !== undefined && raw !== null && raw !== "") tally(states, String(raw), item);
  }
  tally(codes, productCode(item) || "(sin codigo)", item);
  tally(offers, offerLabel(item) || "(sin etiqueta)", item);
}

const unrecognisedStates = [...states.entries()]
  .filter(([raw]) => !RECOGNISED_STATES.has(normalizeState(raw)))
  .sort((a, b) => b[1].count - a[1].count);

const rows = (map) => [...map.entries()]
  .map(([key, entry]) => ({ key, count: entry.count, clasificacion: [...entry.clasificaciones].sort().join(" / ") }))
  .sort((a, b) => b.count - a.count);

const codeRows = rows(codes);
const offerRows = rows(offers);

console.log(`Suscripciones en caché: ${subscriptions.length} (${files.length} ficheros)\n`);

console.log("ESTADOS QUE NINGUNA REGLA RECONOCE");
if (unrecognisedStates.length === 0) {
  console.log("  ninguno: todos los estados se interpretan.\n");
} else {
  console.log("  Un estado no reconocido se trata como si no fuese cancelado, así que");
  console.log("  cuenta en altas, bajas o facturación. Revisa si alguno debería excluirse.");
  console.log("  Los marcados [pago] sí están cubiertos: cuentan como socio activo y");
  console.log("  quedan anotados como incidencia de pago.\n");
  for (const [raw, entry] of unrecognisedStates) {
    const marca = isPaymentIncidence({ status: raw }) ? " [pago]" : "";
    console.log(`  ${String(entry.count).padStart(6)}  ${raw}${marca}`);
  }
  console.log();
}

console.log("CÓDIGOS DE PRODUCTO");
for (const row of codeRows) {
  console.log(`  ${String(row.count).padStart(6)}  ${row.key.padEnd(24)} ${row.clasificacion}`);
}
console.log();

console.log("ETIQUETAS DE OFERTA");
console.log("  Comprueba que cada una esté en la columna que le toca.\n");
for (const row of offerRows.slice(0, 60)) {
  console.log(`  ${String(row.count).padStart(6)}  ${row.key.slice(0, 58).padEnd(60)} ${row.clasificacion}`);
}
if (offerRows.length > 60) console.log(`  … y ${offerRows.length - 60} etiquetas más (ver el JSON).`);

const reportFile = join(rootDir, "artifacts", "auditoria-clasificacion.json");
await writeFile(reportFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  subscriptions: subscriptions.length,
  estadosSinReconocer: unrecognisedStates.map(([raw, entry]) => ({
    estado: raw, count: entry.count, incidenciaDePago: isPaymentIncidence({ status: raw }),
  })),
  codigos: codeRows,
  ofertas: offerRows,
}, null, 2));

console.log(`\nInforme completo en ${reportFile}`);
console.log("Ese fichero no contiene datos personales: sólo etiquetas, códigos y recuentos.");
