import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const rootDir = "/Users/user/resamania-agent";
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3043";
const periodStart = "2026-07-01";
const periodEnd = "2026-07-31";
const scanStart = "2026-06-01";

const context = await chromium.launchPersistentContext(`${rootDir}/.browser-profile-group`, {
  channel: "chrome",
  headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(appBase, { waitUntil: "domcontentloaded", timeout: 45000 });
  const club = page.getByRole("button", { name: "On Air Valencia Ruzafa", exact: true });
  if (!(await club.isVisible().catch(() => false))) {
    const selector = page.getByRole("button", { name: "Club", exact: true });
    if (await selector.isVisible().catch(() => false)) await selector.click();
  }
  if (await club.isVisible().catch(() => false)) await club.click();
  await page.waitForTimeout(1500);

  let seed;
  page.on("response", (response) => {
    if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response;
  });
  await page.goto(`${appBase}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  for (let index = 0; index < 30 && !seed; index += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("No se cargó la sesión de Ruzafa");
  const raw = await seed.request().allHeaders();
  const headers = {
    ...Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":"))),
    "x-user-club-id": clubId,
  };

  const candidates = new Map();
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const params = new URLSearchParams({
      "contact.clubId": clubId,
      "order[validFrom]": "desc",
      page: String(pageNumber),
    });
    const response = await context.request.get(`${apiBase}/subscriptions?${params}`, { headers, timeout: 30000 });
    if (!response.ok()) throw new Error(`Abonos: HTTP ${response.status()}`);
    const payload = await response.json();
    const members = payload["hydra:member"] ?? [];
    for (const subscription of members) {
      const code = String(subscription.initialInfo?.productCode ?? "").toLowerCase();
      const validFrom = subscription.validFrom?.slice(0, 10);
      const validThrough = subscription.validThrough?.slice(0, 10) ?? "9999-12-31";
      if (code !== "cdd2" || !validFrom || validFrom > periodEnd || validThrough < periodStart) continue;
      const contact = subscription.contact ?? {};
      const contactId = subscription.contactId ?? contact["@id"];
      if (!contactId) continue;
      const existing = candidates.get(contactId) ?? {
        contactId,
        number: contact.number ?? null,
        givenName: contact.givenName ?? null,
        familyName: contact.familyName ?? null,
        subscriptions: [],
      };
      existing.subscriptions.push({
        id: subscription["@id"],
        name: subscription.name ?? subscription.initialInfo?.productName,
        validFrom,
        validThrough: subscription.validThrough?.slice(0, 10) ?? null,
      });
      candidates.set(contactId, existing);
    }
    const oldest = members.at(-1)?.validFrom?.slice(0, 10);
    if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < scanStart)) break;
  }

  const rows = [];
  for (const candidate of candidates.values()) {
    let successfulAccesses = 0;
    let rejectedAccesses = 0;
    for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
      const params = new URLSearchParams({
        actor: candidate.contactId,
        "order[createdAt]": "desc",
        page: String(pageNumber),
      });
      const response = await context.request.get(`${apiBase}/cards?${params}`, { headers, timeout: 30000 });
      if (!response.ok()) throw new Error(`Historial ${candidate.contactId}: HTTP ${response.status()}`);
      const payload = await response.json();
      const cards = payload["hydra:member"] ?? [];
      for (const card of cards) {
        const date = card.createdAt?.slice(0, 10);
        if (date < periodStart || date > periodEnd) continue;
        if (card.verb === "ACCESS_OK") successfulAccesses += 1;
        if (card.verb === "ACCESS_KO") rejectedAccesses += 1;
      }
      const oldest = cards.at(-1)?.createdAt?.slice(0, 10);
      if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < periodStart)) break;
    }
    if (successfulAccesses === 0) rows.push({ ...candidate, successfulAccesses, rejectedAccesses });
  }

  rows.sort((a, b) => `${a.familyName} ${a.givenName}`.localeCompare(`${b.familyName} ${b.givenName}`, "es"));
  const output = {
    generatedAt: new Date().toISOString(),
    club: "On Air Valencia Ruzafa",
    period: { from: periodStart, to: periodEnd },
    criterion: "Abono 1 Mes (cdd2) vigente en julio y cero eventos ACCESS_OK durante julio",
    candidateCount: candidates.size,
    matchCount: rows.length,
    rows,
  };
  await writeFile(`${rootDir}/artifacts/ruzafa-july-monthly-no-access.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  await context.close();
}
