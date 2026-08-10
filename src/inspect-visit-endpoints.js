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
  page.on("response", (response) => { if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response; });
  await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043", { waitUntil: "domcontentloaded", timeout: 45000 });
  for (let i = 0; i < 30 && !seed; i += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión");
  const raw = await seed.request().allHeaders();
  const headers = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":")));
  const endpoints = ["prospectings"];
  const results = [];
  for (const endpoint of endpoints) {
    const params = new URLSearchParams({ clubId, page: "1" });
    try {
      const response = await context.request.get(`${apiBase}/${endpoint}?${params}`, { headers: { ...headers, "x-user-club-id": clubId }, timeout: 12000 });
      let payload;
      try { payload = await response.json(); } catch {}
      results.push({ endpoint, status: response.status(), sample: payload?.["hydra:member"]?.[0] ?? null, search: payload?.["hydra:search"] ?? null, detail: payload?.detail ?? null });
    } catch (error) { results.push({ endpoint, status: "timeout", detail: error.message.split("\n")[0] }); }
  }
  const contactParams = new URLSearchParams({ clubId, "order[createdAt]": "desc", page: "1" });
  const contactResponse = await context.request.get(`${apiBase}/contacts?${contactParams}`, { headers: { ...headers, "x-user-club-id": clubId } });
  const contactPayload = await contactResponse.json();
  const contactChecks = [];
  for (const contact of (contactPayload["hydra:member"] ?? []).slice(0, 4)) {
    const contactId = contact["@id"];
    const prospectParams = new URLSearchParams({ contact: contactId, clubId });
    const prospectResponse = await context.request.get(`${apiBase}/prospectings?${prospectParams}`, { headers: { ...headers, "x-user-club-id": clubId }, timeout: 5000 });
    const prospectPayload = prospectResponse.ok() ? await prospectResponse.json() : {};
    const checkResponse = await context.request.get(`${apiBase}/prospectings_check?contactId=${encodeURIComponent(contactId)}`, { headers: { ...headers, "x-user-club-id": clubId }, timeout: 5000 });
    let checkPayload = null;
    try { checkPayload = await checkResponse.json(); } catch {}
    contactChecks.push({ contact: { id: contactId, number: contact.number, state: contact.state, createdAt: contact.createdAt, channel: contact.channel }, prospectings: prospectPayload["hydra:member"] ?? [], checkStatus: checkResponse.status(), check: checkPayload });
  }
  results.push({ endpoint: "contact_prospecting_checks", status: 200, contacts: contactChecks });
  await writeFile(`${rootDir}/artifacts/visit-endpoints-inspection.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ endpoint, status, sample, detail }) => ({ endpoint, status, keys: Object.keys(sample ?? {}), detail })), null, 2));
} finally { await context.close(); }
