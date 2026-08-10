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
  page.on("response", (response) => {
    if (["xhr", "fetch"].includes(response.request().resourceType())) {
      captures.push({ status: response.status(), url: response.url() });
      if (/prospect|commercial|appointment|visit|action/i.test(response.url()) && response.status() === 200) {
        response.json().then((payload) => samples.push({ url: response.url(), sample: payload?.["hydra:member"]?.[0] ?? payload })).catch(() => {});
      }
    }
  });
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(6000);
  await page.keyboard.press("Escape");
  const link = page.getByText("Acciones comerciales", { exact: true }).first();
  await link.evaluate((element) => element.click());
  await page.waitForTimeout(12000);
  const output = { url: page.url(), bodyText: (await page.locator("body").innerText()).slice(0, 18000), captures, samples };
  await writeFile(`${rootDir}/artifacts/visits-inspection.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ url: output.url, relevant: captures.filter((row) => /prospect|commercial|appointment|visit|action/i.test(row.url)) }, null, 2));
} finally {
  await context.close();
}
