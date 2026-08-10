import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const clubs = [
  { slug: "ruzafa", id: 13125, name: "ON AIR Valencia Ruzafa" },
  { slug: "nuevo-centro", id: 13490, name: "ON AIR Valencia Nuevo Centro" },
  { slug: "les-arts", id: 13886, name: "ON AIR Valencia Les Arts" },
  { slug: "madrid", id: 14179, name: "ON AIR Madrid Delicias" },
];
const context = await chromium.launchPersistentContext(`${rootDir}/.lead-profile`, {
  channel: "chrome", headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  const results = [];
  for (const club of clubs) {
    const captures = [];
    const listener = async (response) => {
      const request = response.request();
      if (!["xhr", "fetch"].includes(request.resourceType())) return;
      if (!response.url().includes("lead.masalledesport.com/api/")) return;
      const row = { method: request.method(), status: response.status(), url: response.url(), postData: request.postData() };
      const contentType = (await response.allHeaders())["content-type"] ?? "";
      if (contentType.includes("application/json")) row.body = await response.json().catch(() => null);
      captures.push(row);
    };
    page.on("response", listener);
    await page.goto(`https://lead.masalledesport.com/club/${club.id}/statistics`, {
      waitUntil: "domcontentloaded", timeout: 90000,
    });
    await page.waitForTimeout(10000);
    results.push({
      ...club, url: page.url(), title: await page.title(),
      bodyText: (await page.locator("body").innerText()).slice(0, 40000), captures,
    });
    page.off("response", listener);
  }
  await writeFile(`${rootDir}/artifacts/lead-statistics-inspection.json`, JSON.stringify({
    capturedAt: new Date().toISOString(), results,
  }, null, 2));
  console.log(JSON.stringify(results.map(({ slug, url, captures }) => ({ slug, url, captures: captures.length })), null, 2));
} finally {
  await context.close();
}
