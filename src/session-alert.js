/**
 * Aviso por correo cuando la sesión de Resamania caduca.
 *
 * La recogida corre cada cinco minutos: 288 pasadas al día. Avisar en cada
 * pasada fallida sería un correo cada cinco minutos hasta que alguien mirase,
 * así que sólo se escribe en los cambios de estado, más un recordatorio
 * espaciado mientras siga caído.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Recordatorio mientras la sesión siga caída. */
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Centros cuya última lectura viene de una sesión caducada. */
export function failingClubs(results = []) {
  return results
    .filter((result) => result.authFailed === true || result.lastAuthFailed === true)
    .map((result) => result.name ?? result.slug);
}

/**
 * Decide si toca escribir. Separado del envío para poder probarlo sin red.
 *
 * - sano   → caído : aviso
 * - caído  → caído : recordatorio sólo si ha pasado el tiempo de espera
 * - caído  → sano  : aviso de recuperación
 */
export function decideAlert({ results = [], state = null, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const clubs = failingClubs(results);
  const failing = clubs.length > 0;
  const wasFailing = state?.failing === true;

  if (failing && !wasFailing) {
    return { action: "alert", clubs, state: { failing: true, clubs, lastSentAt: now } };
  }
  if (failing && wasFailing) {
    const elapsed = now - (state.lastSentAt ?? 0);
    if (elapsed >= cooldownMs) {
      return { action: "reminder", clubs, state: { failing: true, clubs, lastSentAt: now } };
    }
    return { action: "none", clubs, state: { ...state, clubs } };
  }
  if (!failing && wasFailing) {
    return { action: "recovery", clubs: [], state: { failing: false, clubs: [], lastSentAt: now } };
  }
  return { action: "none", clubs: [], state: { failing: false, clubs: [], lastSentAt: state?.lastSentAt ?? null } };
}

/** Asunto y cuerpo según el tipo de aviso. */
export function composeMessage(action, clubs, { period } = {}) {
  const list = clubs.join(", ");
  if (action === "recovery") {
    return {
      subject: "Dashboard On Air: sesión de Resamania restablecida",
      text: "La recogida vuelve a obtener datos de Resamania. No hay que hacer nada.",
    };
  }
  const prefix = action === "reminder" ? "Recordatorio: la sesión sigue caducada" : "La sesión de Resamania ha caducado";
  return {
    subject: `Dashboard On Air: sesión de Resamania caducada (${clubs.length} ${clubs.length === 1 ? "centro" : "centros"})`,
    text: [
      `${prefix}.`,
      "",
      `Centros afectados: ${list}.`,
      period ? `Periodo de la última recogida: ${period}.` : null,
      "",
      "Mientras tanto el dashboard muestra la última captura válida de esos centros,",
      "marcada como histórica: no son los datos de hoy.",
      "",
      "Para arreglarlo, en el ordenador del dashboard:",
      "  npm run setup:group",
      "",
      "La siguiente recogida automática lo recuperará sola.",
    ].filter((line) => line !== null).join("\n"),
  };
}

/** Configuración desde el entorno. Devuelve null si falta lo imprescindible. */
export function mailerConfig(env = process.env) {
  const host = env.SMTP_HOST;
  const to = env.ALERT_TO ?? "santiagorico@onair-fitness.es";
  if (!host || !to) return null;
  return {
    host,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === "true" || Number(env.SMTP_PORT) === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    from: env.ALERT_FROM ?? env.SMTP_USER ?? to,
    to,
  };
}

async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Punto de entrada del colector. Nunca lanza: un fallo enviando correo no
 * puede tumbar una recogida que sí ha funcionado.
 */
export async function runSessionAlert({
  snapshotFile,
  stateFile,
  env = process.env,
  now = Date.now(),
  send,
  logger = console,
} = {}) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
  } catch {
    return { action: "none", reason: "sin snapshot" };
  }

  const state = await readState(stateFile);
  const decision = decideAlert({ results: snapshot.results ?? [], state, now });
  await writeState(stateFile, decision.state);

  if (decision.action === "none") return { action: "none" };

  const config = mailerConfig(env);
  if (!config) {
    logger.error(
      "Hay un aviso de sesión que enviar, pero falta configurar SMTP_HOST. Consulta docs/despliegue.md.",
    );
    return { action: decision.action, reason: "sin configuración smtp" };
  }

  const message = composeMessage(decision.action, decision.clubs, { period: snapshot.period });

  try {
    const deliver = send ?? (await defaultSender(config));
    await deliver({ from: config.from, to: config.to, subject: message.subject, text: message.text });
    logger.error(`Aviso enviado a ${config.to}: ${message.subject}`);
    return { action: decision.action, sent: true };
  } catch (error) {
    logger.error(`No se pudo enviar el aviso de sesión: ${error.message}`);
    return { action: decision.action, sent: false, error: error.message };
  }
}

async function defaultSender(config) {
  const { createTransport } = await import("nodemailer");
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  return (message) => transport.sendMail(message);
}
