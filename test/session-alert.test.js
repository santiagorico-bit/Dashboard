import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeMessage,
  decideAlert,
  DEFAULT_COOLDOWN_MS,
  failingClubs,
  mailerConfig,
  runSessionAlert,
} from "../src/session-alert.js";

const caido = [{ slug: "madrid", name: "Madrid Delicias", authFailed: true }];
const reutilizado = [{ slug: "ruzafa", name: "Valencia Ruzafa", ok: true, lastAuthFailed: true }];
const sano = [{ slug: "madrid", name: "Madrid Delicias", ok: true }];

test("detecta tanto el fallo directo como la captura reutilizada", () => {
  assert.deepEqual(failingClubs(caido), ["Madrid Delicias"]);
  assert.deepEqual(failingClubs(reutilizado), ["Valencia Ruzafa"]);
  assert.deepEqual(failingClubs(sano), []);
});

test("un fallo de red no dispara el aviso de sesión", () => {
  const results = [{ slug: "madrid", name: "Madrid", ok: false, error: "timeout", authFailed: false }];
  assert.deepEqual(failingClubs(results), []);
});

test("avisa al pasar de sano a caído", () => {
  const decision = decideAlert({ results: caido, state: { failing: false }, now: 1000 });
  assert.equal(decision.action, "alert");
  assert.deepEqual(decision.clubs, ["Madrid Delicias"]);
  assert.equal(decision.state.failing, true);
});

test("no repite el aviso en cada pasada mientras siga caído", () => {
  const state = { failing: true, lastSentAt: 1000 };
  // Cinco minutos después: la siguiente pasada no debe escribir.
  const decision = decideAlert({ results: caido, state, now: 1000 + 5 * 60 * 1000 });
  assert.equal(decision.action, "none");
});

test("288 pasadas fallidas en un día generan un aviso, no 288", () => {
  let state = { failing: false };
  let sent = 0;
  for (let i = 0; i < 288; i += 1) {
    const decision = decideAlert({ results: caido, state, now: i * 5 * 60 * 1000 });
    if (decision.action !== "none") sent += 1;
    state = decision.state;
  }
  // Uno inicial más un recordatorio cada seis horas a lo largo de 24 h.
  assert.equal(sent, 4);
});

test("recuerda cuando pasa el tiempo de espera", () => {
  const state = { failing: true, lastSentAt: 0 };
  const decision = decideAlert({ results: caido, state, now: DEFAULT_COOLDOWN_MS });
  assert.equal(decision.action, "reminder");
});

test("avisa de la recuperación al volver a funcionar", () => {
  const decision = decideAlert({ results: sano, state: { failing: true, lastSentAt: 0 }, now: 5000 });
  assert.equal(decision.action, "recovery");
  assert.equal(decision.state.failing, false);
});

test("con todo sano y sin historial no escribe nada", () => {
  assert.equal(decideAlert({ results: sano, state: null, now: 0 }).action, "none");
});

test("el mensaje dice qué centros y qué comando ejecutar", () => {
  const { subject, text } = composeMessage("alert", ["Madrid Delicias"], { period: "2026-08-10" });
  assert.match(subject, /caducada \(1 centro\)/);
  assert.match(text, /Madrid Delicias/);
  assert.match(text, /npm run setup:group/);
  assert.match(text, /2026-08-10/);
});

test("el aviso de recuperación no pide hacer nada", () => {
  const { subject, text } = composeMessage("recovery", []);
  assert.match(subject, /restablecida/);
  assert.match(text, /No hay que hacer nada/);
});

test("el destinatario por defecto es el acordado", () => {
  const config = mailerConfig({ SMTP_HOST: "smtp.test" });
  assert.equal(config.to, "santiagorico@onair-fitness.es");
  assert.equal(config.port, 587);
  assert.equal(config.secure, false);
});

test("el puerto 465 activa TLS directo", () => {
  assert.equal(mailerConfig({ SMTP_HOST: "smtp.test", SMTP_PORT: "465" }).secure, true);
});

test("sin SMTP_HOST no hay configuración", () => {
  assert.equal(mailerConfig({}), null);
});

test("runSessionAlert envía una vez y guarda el estado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alerta-"));
  const snapshotFile = join(dir, "dashboard-live.json");
  const stateFile = join(dir, "estado.json");
  await writeFile(snapshotFile, JSON.stringify({ period: "2026-08-10", results: caido }));

  const enviados = [];
  const env = { SMTP_HOST: "smtp.test", ALERT_TO: "santiagorico@onair-fitness.es" };
  const send = async (message) => enviados.push(message);

  const first = await runSessionAlert({ snapshotFile, stateFile, env, send, now: 1000, logger: { error() {} } });
  assert.equal(first.action, "alert");
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, "santiagorico@onair-fitness.es");

  const second = await runSessionAlert({ snapshotFile, stateFile, env, send, now: 2000, logger: { error() {} } });
  assert.equal(second.action, "none");
  assert.equal(enviados.length, 1, "la segunda pasada no debe volver a escribir");

  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).failing, true);
});

test("un fallo del correo no tumba la recogida", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alerta-"));
  const snapshotFile = join(dir, "dashboard-live.json");
  await writeFile(snapshotFile, JSON.stringify({ results: caido }));

  const result = await runSessionAlert({
    snapshotFile,
    stateFile: join(dir, "estado.json"),
    env: { SMTP_HOST: "smtp.test" },
    send: async () => { throw new Error("conexión rechazada"); },
    now: 1000,
    logger: { error() {} },
  });

  assert.equal(result.sent, false);
  assert.match(result.error, /conexión rechazada/);
});

test("sin snapshot no hace nada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alerta-"));
  const result = await runSessionAlert({
    snapshotFile: join(dir, "no-existe.json"),
    stateFile: join(dir, "estado.json"),
    env: { SMTP_HOST: "smtp.test" },
    send: async () => { throw new Error("no debería enviarse"); },
    logger: { error() {} },
  });
  assert.equal(result.action, "none");
});
