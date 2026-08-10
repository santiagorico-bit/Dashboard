import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
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

const fitnessCode = await run("collect-fitness-kpi.js", { optional: true });
if (fitnessCode !== 0) console.error("FitnessKPI no se actualizó; no se usará una captura de otro día.");
const leadCode = await run("collect-lead.js", { optional: true });
if (leadCode !== 0) console.error("Lead 2.0 no se actualizó; se conservará la última captura disponible.");
await run("collect-dashboard.js");
const returnFeeCode = await run("extract-nuevo-centro-return-fee-cancellations.js", { optional: true });
if (returnFeeCode !== 0) console.error("No se actualizó el listado de bajas automáticas por gastos de devolución.");
