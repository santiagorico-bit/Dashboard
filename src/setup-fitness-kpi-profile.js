import { chromium } from "playwright";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const context = await chromium.launchPersistentContext(`${rootDir}/.fitness-kpi-profile`, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://app.fitness-kpi.com/center/reports/daily?report-view=config", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
console.log("FitnessKPI abierto. Inicia sesión y deja la vista de configuración abierta.");
await new Promise((resolve) => context.on("close", resolve));
