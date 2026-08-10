import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const rootDir = "/Users/user/resamania-agent";
const apiBase = "https://api.resamania.com/onairespana";
const context = await chromium.launchPersistentContext(`${rootDir}/.browser-profile-group`, {
  channel: "chrome",
  headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  const requests = [];
  page.on("response", (response) => {
    if (["xhr", "fetch"].includes(response.request().resourceType())) {
      requests.push({ status: response.status(), url: response.url() });
    }
  });
  await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(4000);
  const row = page.getByText("Smith", { exact: true }).first();
  await row.evaluate((element) => element.click());
  await page.waitForTimeout(5000);
  const before = await page.locator("button,a,[role=button]").evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") || "").trim(),
    aria: element.getAttribute("aria-label"),
    title: element.getAttribute("title"),
  })).filter((row) => row.text || row.aria || row.title));
  await page.getByText(/HISTORIAL/i).first().click();
  await page.waitForTimeout(5000);
  const accessStats = page.getByText("Ver las estadísticas de acceso", { exact: true });
  if (await accessStats.isVisible().catch(() => false)) {
    await accessStats.click();
    await page.waitForTimeout(5000);
  }
  const after = await page.locator("button,a,[role=button],li").evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") || "").trim(),
  })).filter((row) => row.text));
  await page.waitForTimeout(1000);
  const output = { generatedAt: new Date().toISOString(), url: page.url(), before, after, requests: requests.slice(-100) };
  await writeFile(`${rootDir}/artifacts/contact-access-discovery.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ url: output.url, accessElements: after.filter((row) => /acceso/i.test(row.text)), requests: output.requests.filter((row) => /access|entry|entr|passage|check|contact/i.test(row.url)) }, null, 2));
} finally {
  await context.close();
}
