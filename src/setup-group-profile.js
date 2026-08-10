import { chromium } from "playwright";
import process from "node:process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileDir = `${rootDir}/.browser-profile-group`;
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://app.resamania.com/onairespana", {
  waitUntil: "domcontentloaded",
});
console.log("Inicia sesión y selecciona Grupo de clubes.");
console.log("Pulsa Intro cuando veas la pantalla principal del grupo.");
process.stdin.setEncoding("utf8");
await new Promise((resolve) => process.stdin.once("data", resolve));
await context.close();
