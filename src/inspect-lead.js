import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const context = await chromium.launchPersistentContext(`${rootDir}/.lead-profile`, {
  channel: "chrome",
  headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  const captures = [];
  page.on("response", async (response) => {
    const request = response.request();
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    const row = {
      method: request.method(), status: response.status(), url: response.url(),
      postData: request.postData(),
    };
    const contentType = (await response.allHeaders())["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      row.body = await response.json().catch(() => null);
    }
    captures.push(row);
  });
  await page.goto("https://lead.masalledesport.com/club/13490/lead", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  await page.waitForTimeout(12000);
  const output = {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title(),
    bodyText: (await page.locator("body").innerText()).slice(0, 30000),
    links: await page.locator("a").evaluateAll((nodes) => nodes.slice(0, 300).map((node) => ({
      text: node.innerText?.trim(), href: node.href,
    }))),
    buttons: await page.getByRole("button").allTextContents(),
    localStorage: await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))),
    captures,
  };
  await writeFile(`${rootDir}/artifacts/lead-inspection.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ url: output.url, title: output.title, captures: captures.length }, null, 2));
} finally {
  await context.close();
}
