import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSessionAlert } from "./session-alert.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const lockFile = join(rootDir, "artifacts", ".collect-all.lock");
// Una recogida atascada no debe bloquear las siguientes para siempre.
const staleLockMs = 2 * 60 * 60 * 1000;

const run = (script, { optional = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(rootDir, "src", script)], {
    cwd: rootDir,
    stdio: "inherit",
  });
  child.once("error", optional ? resolve : reject);
  child.once("exit", (code) => {
    if (code === 0 || optional) resolve(code);
    else reject(new Error(`${script} terminó con código ${code}`));
  });
});

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM significa que el proceso existe pero es de otro usuario.
    return error.code === "EPERM";
  }
}

/**
 * Cada recogida abre Chrome con un perfil persistente. Dos pasadas a la vez
 * se pelean por ese perfil y fallan con un error que no explica nada, así que
 * la segunda se retira sin tocar nada.
 */
async function acquireLock() {
  await mkdir(dirname(lockFile), { recursive: true });
  try {
    const previous = JSON.parse(await readFile(lockFile, "utf8"));
    const age = Date.now() - Date.parse(previous.startedAt);
    if (isRunning(previous.pid) && age < staleLockMs) {
      console.error(
        `Ya hay una recogida en curso (PID ${previous.pid}, desde ${previous.startedAt}). Se omite esta pasada.`,
      );
      process.exit(0);
    }
    if (isRunning(previous.pid)) {
      console.error(`La recogida del PID ${previous.pid} lleva más de dos horas; se considera atascada y se continúa.`);
    }
  } catch {
    // Sin bloqueo previo, o ilegible: se sigue adelante.
  }
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
}

await acquireLock();
try {
  const fitnessCode = await run("collect-fitness-kpi.js", { optional: true });
  if (fitnessCode !== 0) console.error("FitnessKPI no se actualizó; no se usará una captura de otro día.");
  const leadCode = await run("collect-lead.js", { optional: true });
  if (leadCode !== 0) console.error("Lead 2.0 no se actualizó; se conservará la última captura disponible.");
  // La recogida de Resamania puede fallar por sesión caducada; el aviso se
  // manda igualmente más abajo, por eso no se interrumpe aquí.
  const dashboardResult = await run("collect-dashboard.js").then(() => null, (error) => error);
  const returnFeeCode = await run("extract-nuevo-centro-return-fee-cancellations.js", { optional: true });
  if (returnFeeCode !== 0) console.error("No se actualizó el listado de bajas automáticas por gastos de devolución.");

  await runSessionAlert({
    snapshotFile: join(rootDir, "artifacts", "dashboard-live.json"),
    stateFile: join(rootDir, "artifacts", ".session-alert.json"),
  });

  if (dashboardResult) throw dashboardResult;
} finally {
  await rm(lockFile, { force: true });
}
