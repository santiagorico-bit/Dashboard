import { chromium } from "playwright";
import process from "node:process";

const profileDir = new URL("../.browser-profile/", import.meta.url).pathname;
const startUrl = "https://app.resamania.com/onairespana";

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(startUrl, { waitUntil: "domcontentloaded" });

console.log("Completa el inicio de sesión en Chrome y vuelve a esta terminal.");
console.log("Pulsa Intro cuando veas la pantalla principal de Resamania.");

process.stdin.setEncoding("utf8");
await new Promise((resolve) => process.stdin.once("data", resolve));
await context.close();

