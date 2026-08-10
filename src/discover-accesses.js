import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const rootDir = "/Users/user/resamania-agent";
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
  await page.goto("https://app.resamania.com/onairespana", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  const club = page.getByRole("button", { name: "On Air Valencia Ruzafa", exact: true });
  if (!(await club.isVisible().catch(() => false))) {
    const selector = page.getByRole("button", { name: "Club", exact: true });
    if (await selector.isVisible().catch(() => false)) await selector.click();
  }
  await club.click();
  await page.waitForTimeout(2000);
  const accesses = page.getByText("Accesos", { exact: true }).first();
  await accesses.click();
  await page.waitForTimeout(1000);
  const accessElements = await page.locator("a,button,[role=button]").evaluateAll((elements) =>
    elements.map((element) => ({
      text: (element.innerText || element.getAttribute("aria-label") || "").trim(),
      href: element.getAttribute("href"),
    })).filter((row) => /acceso|asistencia|entrada|historial/i.test(row.text)),
  );
  const accessLink = page.getByText(/historial.*acceso|accesos.*cliente|lista.*acceso/i).first();
  if (await accessLink.isVisible().catch(() => false)) await accessLink.click();
  await page.waitForTimeout(5000);
  const output = {
    generatedAt: new Date().toISOString(),
    url: page.url(),
    accessElements,
    requests: requests.filter((row) => /access|entry|entr|passage|check/i.test(row.url)),
    recentRequests: requests.slice(-80),
  };
  await writeFile(`${rootDir}/artifacts/accesses-discovery.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  await context.close();
}
