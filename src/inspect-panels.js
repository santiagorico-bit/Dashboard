import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const startUrl = "https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043";
const context = await chromium.launchPersistentContext(`${rootDir}/.club-profiles/ruzafa`, { channel: "chrome", headless: true });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const captures = [];
  const samples = [];
  let phase = "start";
  page.on("response", (response) => {
    if (["xhr", "fetch"].includes(response.request().resourceType())) {
      captures.push({ phase, status: response.status(), url: response.url() });
      if (response.status() === 200 && /dashboard|widget|meter|prospect|visit|conversion|stat/i.test(response.url())) {
        response.json().then((payload) => samples.push({ phase, url: response.url(), payload })).catch(() => {});
      }
    }
  });
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);
  await page.keyboard.press("Escape");
  phase = "panels";
  await page.getByText("Paneles", { exact: true }).first().evaluate((element) => element.click());
  await page.waitForTimeout(800);
  phase = "client-dashboard";
  await page.getByText("Tus clientes", { exact: true }).first().evaluate((element) => element.click());
  await page.waitForTimeout(12000);
  const panelLinks = await page.locator("a").evaluateAll((links) => links.map((link) => ({ text: link.textContent?.trim(), href: link.href })).filter((link) => link.text));
  const output = { url: page.url(), bodyText: (await page.locator("body").innerText()).slice(0, 24000), panelLinks, captures, samples };
  await writeFile(`${rootDir}/artifacts/panels-inspection.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ url: output.url, panelLinks: panelLinks.slice(0, 30), relevant: captures.filter((row) => /dashboard|widget|meter|prospect|visit|conversion|stat/i.test(row.url)) }, null, 2));
} finally {
  await context.close();
}
