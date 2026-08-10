import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile`;
const listUrl =
  "https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/cancellations";

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
const responses = [];

page.on("response", (response) => {
  if (["xhr", "fetch"].includes(response.request().resourceType())) {
    responses.push({
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    });
  }
});

await page.goto("about:blank");
await page.goto(listUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
await page.keyboard.press("Escape");

const rows = page.locator("[data-testid='infinite-list'] .flextable-row");
const rowCount = await rows.count();
if (rowCount > 1) {
  await rows.nth(1).click({ force: true });
  await page.waitForTimeout(8000);
  const historyTab = page.getByText("HISTORIAL", { exact: true });
  if (await historyTab.isVisible().catch(() => false)) {
    await historyTab.evaluate((element) => element.click());
    await page.waitForTimeout(8000);
  }
}

const bodyText = await page.locator("body").innerText();
await writeFile(
  `${artifactsDir}/cancellation-history-inspection.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      url: page.url(),
      rowCount,
      bodyText: bodyText.slice(0, 25000),
      responses,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`Filas visibles: ${rowCount}`);
console.log(`Inspección guardada en artifacts/cancellation-history-inspection.json`);
await context.close();
