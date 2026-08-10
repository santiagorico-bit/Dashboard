import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3043";
const context = await chromium.launchPersistentContext(`${rootDir}/.club-profiles/ruzafa`, { channel: "chrome", headless: true });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  let seed;
  page.on("response", (response) => {
    if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response;
  });
  await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043", { waitUntil: "domcontentloaded", timeout: 45000 });
  for (let i = 0; i < 30 && !seed; i += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión");
  const raw = await seed.request().allHeaders();
  const headers = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":")));
  const get = async (path) => {
    const response = await context.request.get(`${apiBase}/${path}`, { headers: { ...headers, "x-user-club-id": clubId } });
    return { status: response.status(), payload: response.ok() ? await response.json() : null };
  };
  const alerts = await get(`alerts?clubId=${encodeURIComponent(clubId)}&order%5Bid%5D=desc&page=1`);
  const reasons = await get("referentials/blocking_reasons");
  const output = {
    alertSample: alerts.payload?.["hydra:member"]?.slice(0, 10) ?? [],
    reasons: reasons.payload?.["hydra:member"] ?? [],
  };
  await writeFile(`${rootDir}/artifacts/incidences-inspection.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ alertsStatus: alerts.status, reasonsStatus: reasons.status, alertKeys: Object.keys(output.alertSample[0] ?? {}), reasonCount: output.reasons.length }, null, 2));
} finally {
  await context.close();
}
