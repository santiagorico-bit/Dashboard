import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileDir = `${rootDir}/.browser-profile`;
const artifactsDir = `${rootDir}/artifacts`;
const alertsUrl =
  "https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/alerts?clubId=%2Fonairespana%2Fclubs%2F3043";

await mkdir(artifactsDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
const network = [];
const browserErrors = [];
const alertPayloads = [];
const networkNodePayloads = [];

page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});
page.on("pageerror", (error) => browserErrors.push(error.message));

page.on("response", (response) => {
  const request = response.request();
  const contentType = response.headers()["content-type"] ?? "";
  if (
    request.resourceType() === "xhr" ||
    request.resourceType() === "fetch" ||
    contentType.includes("application/json")
  ) {
    network.push({
      method: request.method(),
      status: response.status(),
      url: response.url(),
      contentType,
    });
  }
  if (response.url().includes("/alerts?") && response.status() === 200) {
    response
      .json()
      .then((payload) => alertPayloads.push({ url: response.url(), payload }))
      .catch(() => {});
  }
  if (response.url().includes("/network_nodes") && response.status() === 200) {
    response
      .json()
      .then((payload) => networkNodePayloads.push(payload))
      .catch(() => {});
  }
});

await page.goto(alertsUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);

const clubChoice = page.getByText("On Air Valencia Ruzafa", { exact: true });
if (await clubChoice.isVisible().catch(() => false)) {
  await clubChoice.click({ force: true });
  await page.waitForTimeout(8000);
  await page.goto(alertsUrl, { waitUntil: "domcontentloaded" });
}

await page.waitForTimeout(10000);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
await page.evaluate(() => {
  for (const dialog of document.querySelectorAll("[role='dialog']")) {
    (dialog.closest(".MuiModal-root") ?? dialog).remove();
  }
  document.body.style.overflow = "";
});

const allReasons = page.getByText("Todos los motivos", { exact: true });
if (await allReasons.isVisible().catch(() => false)) {
  await allReasons.focus();
  await allReasons.press("ArrowDown");
  const missingMandate = page.getByText("Falta el mandato", { exact: true });
  await missingMandate.waitFor({ state: "visible", timeout: 10000 });
  await missingMandate.evaluate((element) => element.click());
}

await page.waitForTimeout(10000);

const inspection = await page.evaluate(() => {
  const headers = [...document.querySelectorAll("th, [role='columnheader']")]
    .map((node) => node.textContent?.trim())
    .filter(Boolean);
  const rows = [...document.querySelectorAll("tr, [role='row']")]
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    title: document.title,
    url: location.href,
    headers,
    rowCount: Math.max(0, rows.length - 1),
    sampleRows: rows.slice(0, 6),
    bodyText: document.body.innerText.slice(0, 12000),
  };
});

await writeFile(
  `${artifactsDir}/alerts-inspection.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      inspection,
      network,
      browserErrors,
      alertPayloads,
      networkNodePayloads,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`Inspección guardada en ${artifactsDir}/alerts-inspection.json`);
console.log(`Filas detectadas: ${inspection.rowCount}`);
console.log(`Peticiones de datos detectadas: ${network.length}`);
await context.close();
