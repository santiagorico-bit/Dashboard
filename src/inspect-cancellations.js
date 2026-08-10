import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile`;
const startUrl =
  "https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/alerts?clubId=%2Fonairespana%2Fclubs%2F3043";

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
const responses = [];
const errors = [];
const cancellationPayloads = [];

page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("response", (response) => {
  const request = response.request();
  const contentType = response.headers()["content-type"] ?? "";
  if (
    request.resourceType() === "xhr" ||
    request.resourceType() === "fetch" ||
    contentType.includes("json")
  ) {
    responses.push({
      method: request.method(),
      status: response.status(),
      url: response.url(),
    });
  }
  if (response.url().includes("/cancellations?") && response.status() === 200) {
    response
      .json()
      .then((payload) => cancellationPayloads.push({ url: response.url(), payload }))
      .catch(() => {});
  }
});

await page.goto(startUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
await page.keyboard.press("Escape");
await page.evaluate(() => {
  for (const dialog of document.querySelectorAll("[role='dialog']")) {
    (dialog.closest(".MuiModal-root") ?? dialog).remove();
  }
  document.body.style.overflow = "";
}).catch(() => {});

const cancellationsLink = page.getByText("Bajas", { exact: true }).first();
await cancellationsLink.click({ force: true });
await page.waitForTimeout(15000);

const bodyText = await page.locator("body").innerText();
await writeFile(
  `${artifactsDir}/cancellations-inspection.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      url: page.url(),
      bodyText: bodyText.slice(0, 20000),
      responses,
      cancellationPayloads,
      errors,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`Ruta detectada: ${page.url()}`);
console.log(`Peticiones detectadas: ${responses.length}`);
await context.close();
