import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile`;
const startUrl =
  "https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3042";

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: true,
});
const page = context.pages()[0] ?? (await context.newPage());
const captures = [];
let phase = "members";

page.on("response", (response) => {
  const request = response.request();
  if (["xhr", "fetch"].includes(request.resourceType())) {
    captures.push({ phase, method: request.method(), status: response.status(), url: response.url() });
  }
});

await page.goto("about:blank");
await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(12000);
await page.keyboard.press("Escape");

phase = "finance";
const financeLink = page.getByText("Datos financieros", { exact: true }).first();
if (await financeLink.isVisible().catch(() => false)) {
  await financeLink.click({ force: true });
  await page.waitForTimeout(15000);
}

await writeFile(
  `${artifactsDir}/dashboard-sources-inspection.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      currentUrl: page.url(),
      bodyText: (await page.locator("body").innerText()).slice(0, 25000),
      captures,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`Peticiones detectadas: ${captures.length}`);
await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
