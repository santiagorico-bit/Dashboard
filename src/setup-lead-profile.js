import { chromium } from "playwright";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const context = await chromium.launchPersistentContext(`${rootDir}/.lead-profile`, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://lead.masalledesport.com/club/13490/lead", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
console.log("Lead 2.0 abierto. Inicia sesión y deja visible la pantalla de leads.");
await new Promise((resolve) => context.on("close", resolve));
