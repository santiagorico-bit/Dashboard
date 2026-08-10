import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const rootDir = "/Users/user/resamania-agent";
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com/onairespana";
const periodStart = "2026-07-01";
const periodEnd = "2026-07-31";
const saleWindowEnd = "2026-07-15";
const scanStart = "2026-06-01";
const clubs = [
  ["barcelona", "Barcelona Universitat", "3046", "On Air Barcelona Universitat"],
  ["madrid", "Madrid Delicias", "3044", "On Air Madrid Delicias"],
  ["malaga-armengual", "Málaga Armengual", "3045", "On Air Malaga Armengual"],
  ["malaga-soho", "Málaga Soho", "3270", "On Air Málaga Soho"],
  ["les-arts", "Valencia Les Arts", "3041", "On Air Valencia Les Arts"],
  ["nuevo-centro", "Valencia Nuevo Centro", "3042", "On Air Valencia Nuevo Centro"],
  ["ruzafa", "Valencia Ruzafa", "3043", "On Air Valencia Ruzafa"],
];

const context = await chromium.launchPersistentContext(`${rootDir}/.browser-profile-group`, { channel: "chrome", headless: true });
try {
  const results = [];
  for (const [slug, name, id, selectorLabel] of clubs) {
    const page = context.pages()[0] ?? await context.newPage();
    try {
      await page.goto(appBase, { waitUntil: "domcontentloaded", timeout: 45000 });
      const target = page.getByRole("button", { name: selectorLabel, exact: true });
      if (!(await target.isVisible().catch(() => false))) {
        const selector = page.getByRole("button", { name: "Club", exact: true });
        if (await selector.isVisible().catch(() => false)) await selector.click();
      }
      await target.waitFor({ state: "visible", timeout: 15000 });
      await target.click();
      await page.waitForTimeout(1200);
      let seed;
      page.on("response", (response) => {
        if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response;
      });
      await page.goto(`${appBase}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      for (let index = 0; index < 30 && !seed; index += 1) await page.waitForTimeout(500);
      if (!seed) throw new Error("Sin sesión de datos");
      const raw = await seed.request().allHeaders();
      const clubId = `/onairespana/clubs/${id}`;
      const headers = { ...Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":"))), "x-user-club-id": clubId };
      const candidates = new Map();
      for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
        const params = new URLSearchParams({ "contact.clubId": clubId, "order[validFrom]": "desc", page: String(pageNumber) });
        const response = await context.request.get(`${apiBase}/subscriptions?${params}`, { headers, timeout: 30000 });
        if (!response.ok()) throw new Error(`Abonos HTTP ${response.status()}`);
        const payload = await response.json();
        const members = payload["hydra:member"] ?? [];
        for (const subscription of members) {
          const code = String(subscription.initialInfo?.productCode ?? "").toLowerCase();
          const validFrom = subscription.validFrom?.slice(0, 10);
          const soldAt = subscription.createdAt?.slice(0, 10);
          if (code !== "cdd2" || !soldAt || soldAt < periodStart || soldAt > saleWindowEnd) continue;
          const contact = subscription.contact ?? {};
          const contactId = subscription.contactId ?? contact["@id"];
          if (!contactId) continue;
          candidates.set(contactId, {
            contactId,
            number: contact.number ?? candidates.get(contactId)?.number ?? null,
            givenName: contact.givenName ?? candidates.get(contactId)?.givenName ?? null,
            familyName: contact.familyName ?? candidates.get(contactId)?.familyName ?? null,
            soldAt,
            validFrom,
          });
        }
        const oldest = members.at(-1)?.validFrom?.slice(0, 10);
        if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < scanStart)) break;
      }
      const rows = [];
      const candidateList = [...candidates.values()];
      for (let offset = 0; offset < candidateList.length; offset += 10) {
        const batch = candidateList.slice(offset, offset + 10);
        const checked = await Promise.all(batch.map(async (candidate) => {
          let successfulAccesses = 0;
          for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
            const params = new URLSearchParams({ actor: candidate.contactId, "order[createdAt]": "desc", page: String(pageNumber) });
            const response = await context.request.get(`${apiBase}/cards?${params}`, { headers, timeout: 30000 });
            if (!response.ok()) throw new Error(`Historial HTTP ${response.status()}`);
            const payload = await response.json();
            const cards = payload["hydra:member"] ?? [];
            successfulAccesses += cards.filter((card) => {
              const date = card.createdAt?.slice(0, 10);
              return date >= periodStart && date <= periodEnd && card.verb === "ACCESS_OK";
            }).length;
            const oldest = cards.at(-1)?.createdAt?.slice(0, 10);
            if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < periodStart)) break;
          }
          return successfulAccesses === 0 ? candidate : null;
        }));
        rows.push(...checked.filter(Boolean));
      }
      results.push({ slug, name, ok: true, candidateCount: candidates.size, count: rows.length, rows });
    } catch (error) {
      results.push({ slug, name, ok: false, error: error.message });
    }
  }
  const output = {
    generatedAt: new Date().toISOString(),
    period: { from: periodStart, to: periodEnd, label: "Vendidos 1–15 julio 2026 · accesos 1–31 julio" },
    criterion: "Abono 1 Mes (cdd2) vendido del 1 al 15 de julio de 2026 y cero ACCESS_OK durante julio",
    results,
  };
  await writeFile(`${rootDir}/artifacts/watch-data.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  await context.close();
}
