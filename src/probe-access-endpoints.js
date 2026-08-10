import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const rootDir = "/Users/user/resamania-agent";
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3043";
const context = await chromium.launchPersistentContext(`${rootDir}/.browser-profile-group`, {
  channel: "chrome",
  headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  let seed;
  page.on("response", (response) => {
    if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response;
  });
  await page.goto(`${appBase}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  for (let index = 0; index < 30 && !seed; index += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión de datos");
  const raw = await seed.request().allHeaders();
  const headers = {
    ...Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":"))),
    "x-user-club-id": clubId,
  };
  const query = `clubId=${encodeURIComponent(clubId)}&date%5Bafter%5D=2026-07-01&date%5Bbefore%5D=2026-07-31&page=1`;
  const endpoints = ["attendances"];
  const results = [];
  for (const endpoint of endpoints) {
    try {
      const response = await context.request.get(`${apiBase}/${endpoint}?${query}`, { headers, timeout: 10000 });
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      const members = payload?.["hydra:member"] ?? [];
      results.push({
        endpoint,
        status: response.status(),
        total: payload?.["hydra:totalItems"] ?? null,
        keys: payload ? Object.keys(payload) : [],
        sample: members.slice(0, 2),
        payload: endpoint === "attendances" ? payload : undefined,
      });
    } catch (error) {
      results.push({ endpoint, status: "timeout", error: error.message.split("\n")[0] });
    }
  }
  await writeFile(`${rootDir}/artifacts/access-endpoints-probe.json`, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await context.close();
}
