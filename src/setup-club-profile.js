import { chromium } from "playwright";
import process from "node:process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const clubs = {
  barcelona: "On Air Barcelona Universitat",
  madrid: "On Air Madrid Delicias",
  "malaga-armengual": "On Air Malaga Armengual",
  "malaga-soho": "On Air Málaga Soho",
  "les-arts": "On Air Valencia Les Arts",
  "nuevo-centro": "On Air Valencia Nuevo Centro",
  ruzafa: "On Air Valencia Ruzafa",
};
const slug = process.argv[2];
if (!clubs[slug]) throw new Error(`Club desconocido: ${slug}`);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileDir = `${rootDir}/.club-profiles/${slug}`;
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://app.resamania.com/onairespana", { waitUntil: "domcontentloaded" });
console.log(`Selecciona: ${clubs[slug]}`);
console.log("Pulsa Intro cuando veas la pantalla principal del centro.");
process.stdin.setEncoding("utf8");
await new Promise((resolve) => process.stdin.once("data", resolve));
await context.close();
