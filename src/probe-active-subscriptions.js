import { chromium } from "playwright";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
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
  for (let attempt = 0; attempt < 30 && !seed; attempt += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión");
  const raw = await seed.request().allHeaders();
  const headers = { ...Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":"))), "x-user-club-id": clubId };
  const variants = [
    { name: "base", params: { "contact.clubId": clubId, "order[validFrom]": "desc", page: "1" } },
    { name: "active", params: { "contact.clubId": clubId, "terminatedAt[exists]": "false", "order[validFrom]": "desc", page: "1" } },
    { name: "before", params: { "contact.clubId": clubId, "validFrom[before]": "2026-08-01", "order[validFrom]": "desc", page: "1" } },
    { name: "active-before", params: { "contact.clubId": clubId, "terminatedAt[exists]": "false", "validFrom[before]": "2026-08-01", "order[validFrom]": "desc", page: "1" } },
    { name: "active-before-100", params: { "contact.clubId": clubId, "terminatedAt[exists]": "false", "validFrom[before]": "2026-08-01", "order[validFrom]": "desc", itemsPerPage: "100", page: "1" } },
  ];
  for (const variant of variants) {
    const params = new URLSearchParams(variant.params);
    const response = await context.request.get(`${apiBase}/subscriptions?${params}`, { headers });
    const payload = response.ok() ? await response.json() : {};
    const members = payload["hydra:member"] ?? [];
    console.log(JSON.stringify({
      name: variant.name, status: response.status(), total: payload["hydra:totalItems"],
      first: members[0]?.validFrom, last: members.at(-1)?.validFrom,
      terminated: members.filter((item) => item.terminatedAt).length,
    }));
  }
} finally {
  await context.close();
}
