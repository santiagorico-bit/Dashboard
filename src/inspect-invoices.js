import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3042";
const context = await chromium.launchPersistentContext(`${rootDir}/.club-profiles/nuevo-centro`, {
  channel: "chrome",
  headless: true,
});
const page = context.pages()[0] ?? (await context.newPage());
let contactResponse;
page.on("response", (response) => {
  if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) {
    contactResponse = response;
  }
});
await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3042", { waitUntil: "domcontentloaded", timeout: 45000 });
for (let attempt = 0; attempt < 30 && !contactResponse; attempt += 1) await page.waitForTimeout(500);
if (!contactResponse) throw new Error("Sin sesión de datos");
const rawHeaders = await contactResponse.request().allHeaders();
const headers = Object.fromEntries(Object.entries(rawHeaders).filter(([name]) => !name.startsWith(":")));
const endpoints = ["invoices", "invoice_lines", "credit_notes", "voucher_lines"];
const results = [];
for (const endpoint of endpoints) {
  try {
    const params = new URLSearchParams({ clubId, page: "1" });
    const response = await context.request.get(`${apiBase}/${endpoint}?${params}`, {
      headers: { ...headers, "x-user-club-id": clubId }, timeout: 12000,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    results.push({ endpoint, status: response.status(), sample: payload?.["hydra:member"]?.[0] ?? payload });
  } catch (error) {
    results.push({ endpoint, status: "timeout", error: error.message.split("\n")[0] });
  }
}
await writeFile(`${rootDir}/artifacts/invoices-inspection.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ endpoint, status, sample }) => ({ endpoint, status, keys: sample && typeof sample === "object" ? Object.keys(sample) : [] })), null, 2));
await context.close();
