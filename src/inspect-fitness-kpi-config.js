import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const userDataDir = process.env.FITNESS_KPI_PROFILE_COPY ?? "/tmp/fitness-kpi-chrome-copy";
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: true,
  args: ["--profile-directory=Profile 10"],
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  const responses = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("fitness-kpi.com")) return;
    const contentType = response.headers()["content-type"] ?? "";
    let body = null;
    if (/json|text/.test(contentType)) {
      body = await response.text().catch(() => null);
      if (body?.length > 250000) body = `${body.slice(0, 250000)}\n[truncated]`;
    }
    responses.push({ url, status: response.status(), contentType, body });
  });
  await page.goto("https://app.fitness-kpi.com/center/reports/daily?report-view=config", {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForTimeout(3000);
  const output = {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title(),
    bodyText: (await page.locator("body").innerText()).slice(0, 100000),
    responses,
  };
  await writeFile(`${rootDir}/artifacts/fitness-kpi-config-inspection.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ url: output.url, title: output.title, responseCount: responses.length, bodyPreview: output.bodyText.slice(0, 1000) }, null, 2));
} finally {
  await context.close();
}
