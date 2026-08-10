import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.club-profiles/nuevo-centro`;
const startUrl =
  "https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3042";

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: true,
});
const page = context.pages()[0] ?? (await context.newPage());
const captures = [];
const screens = [];
const samples = {};
let phase = "members";

page.on("response", (response) => {
  if (["xhr", "fetch"].includes(response.request().resourceType())) {
    captures.push({ phase, method: response.request().method(), status: response.status(), url: response.url() });
  }
  if (
    response.status() === 200 &&
    (response.url().includes("/subscriptions?") || response.url().includes("/payments?"))
  ) {
    response.json().then((payload) => {
      samples[phase] = payload["hydra:member"]?.[0] ?? null;
    }).catch(() => {});
  }
});

async function snapshot(label) {
  screens.push({
    label,
    url: page.url(),
    bodyText: (await page.locator("body").innerText()).slice(0, 18000),
  });
}

await page.goto("about:blank");
await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(10000);
await page.keyboard.press("Escape");
await snapshot("members");

phase = "subscriptions";
const subscriptions = page.getByText("Abonos", { exact: true }).first();
await subscriptions.evaluate((element) => element.click());
await page.waitForTimeout(12000);
await snapshot("subscriptions");

await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(7000);
await page.keyboard.press("Escape");
phase = "finance";
const finance = page.getByText("Datos financieros", { exact: true }).first();
await finance.evaluate((element) => element.click());
await page.waitForTimeout(1000);
phase = "payments";
const payments = page.getByText("Pagos", { exact: true }).first();
await payments.evaluate((element) => element.click());
await page.waitForTimeout(15000);
await snapshot("payments");

await writeFile(
  `${artifactsDir}/dashboard-metrics-discovery.json`,
  JSON.stringify({ capturedAt: new Date().toISOString(), screens, captures, samples }, null, 2),
  "utf8",
);
console.log(screens.map(({ label, url }) => ({ label, url })));
await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 4000))]);
