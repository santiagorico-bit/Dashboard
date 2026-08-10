import { chromium } from "playwright";

const rootDir = "/Users/user/resamania-agent";
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3043";
const context = await chromium.launchPersistentContext(`${rootDir}/.browser-profile-group`, { channel: "chrome", headless: true });
try {
  const page = context.pages()[0] ?? await context.newPage();
  let seed;
  page.on("response", (response) => {
    if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response;
  });
  await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043", { waitUntil: "domcontentloaded", timeout: 45000 });
  for (let index = 0; index < 30 && !seed; index += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión");
  const raw = await seed.request().allHeaders();
  const headers = { ...Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":"))), "x-user-club-id": clubId };
  const response = await context.request.get(`${apiBase}/cards?actor=${encodeURIComponent("/onairespana/contacts/19403318")}&page=1`, { headers });
  console.log(JSON.stringify(await response.json(), null, 2));
} finally {
  await context.close();
}
