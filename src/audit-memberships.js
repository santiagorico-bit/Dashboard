import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3041";
const context = await chromium.launchPersistentContext(`${rootDir}/.club-profiles/les-arts`, { channel: "chrome", headless: true });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  let seed;
  page.on("response", (response) => { if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response; });
  await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3041", { waitUntil: "domcontentloaded", timeout: 45000 });
  for (let i = 0; i < 30 && !seed; i += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión");
  const raw = await seed.request().allHeaders();
  const headers = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":")));
  const subscriptions = [];
  for (let pageNumber = 1; pageNumber <= 30; pageNumber += 1) {
    const params = new URLSearchParams({ "contact.clubId": clubId, "order[validFrom]": "desc", page: String(pageNumber) });
    const response = await context.request.get(`${apiBase}/subscriptions?${params}`, { headers: { ...headers, "x-user-club-id": clubId } });
    const payload = await response.json();
    const members = payload["hydra:member"] ?? [];
    subscriptions.push(...members.filter((item) => item.createdAt?.slice(0, 10) >= "2026-08-01"));
    const oldest = members.at(-1)?.validFrom;
    if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < "2026-08-01")) break;
  }
  const rows = subscriptions.map((item) => ({
    id: item["@id"], contactId: item.contactId ?? item.contact?.["@id"], number: item.contact?.number,
    name: item.name, code: item.initialInfo?.productCode, createdAt: item.createdAt, validFrom: item.validFrom,
    consumed: item.consumed, terminatedAt: item.terminatedAt,
  }));
  const grouped = Object.values(rows.reduce((groups, row) => {
    const key = `${row.createdAt}|${row.code}|${row.name}`;
    groups[key] ??= { createdAt: row.createdAt, code: row.code, name: row.name, subscriptions: 0, uniqueContacts: new Set() };
    groups[key].subscriptions += 1; groups[key].uniqueContacts.add(row.contactId); return groups;
  }, {})).map((row) => ({ ...row, uniqueContacts: row.uniqueContacts.size }));
  const output = { generatedAt: new Date().toISOString(), club: "Valencia Les Arts", rows, grouped };
  await writeFile(`${rootDir}/artifacts/les-arts-memberships-audit.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(grouped, null, 2));
} finally { await context.close(); }
