import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const context = await chromium.launchPersistentContext(`${rootDir}/.fitness-kpi-profile`, {
  channel: "chrome", headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  const responses = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("fitness-kpi.com/api/")) return;
    const contentType = response.headers()["content-type"] ?? "";
    let body = null;
    if (contentType.includes("json")) {
      body = await response.text().catch(() => null);
      if (body?.length > 500000) body = `${body.slice(0, 500000)}\n[truncated]`;
    }
    responses.push({
      method: response.request().method(),
      postData: response.request().postData(),
      url, status: response.status(), body,
    });
  });
  await page.goto("https://app.fitness-kpi.com/center/reports/daily?report-view=config", { waitUntil: "networkidle", timeout: 90000 });
  const ruzafa = page.getByText("Valencia - Ruzafa", { exact: true }).first();
  await ruzafa.waitFor({ state: "visible", timeout: 30000 });
  await page.keyboard.press("Escape").catch(() => {});
  await ruzafa.click({ force: true });
  await page.waitForTimeout(4000);
  await page.goto("https://app.fitness-kpi.com/center/reports/daily?report-view=dashboard", { waitUntil: "networkidle", timeout: 120000 });
  const reportRuzafa = page.getByText("Valencia - Ruzafa", { exact: true }).last();
  await reportRuzafa.scrollIntoViewIfNeeded();
  await page.waitForTimeout(8000);
  const output = {
    capturedAt: new Date().toISOString(), url: page.url(), title: await page.title(),
    bodyText: (await page.locator("body").innerText()).slice(0, 100000), responses,
  };
  await writeFile(`${rootDir}/artifacts/fitness-kpi-ruzafa.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ url: output.url, responseCount: responses.length, bodyPreview: output.bodyText.slice(0, 2500) }, null, 2));
} finally {
  await context.close();
}
