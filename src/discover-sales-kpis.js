import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const apiBase = "https://api.resamania.com/onairespana";
const appBase = "https://app.resamania.com/onairespana";
const clubs = [
  ["madrid", "Madrid Delicias", "3044"],
  ["les-arts", "Valencia Les Arts", "3041"],
  ["nuevo-centro", "Valencia Nuevo Centro", "3042"],
  ["ruzafa", "Valencia Ruzafa", "3043"],
];
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const monthStart = `${today.slice(0, 8)}01`;

await mkdir(artifactsDir, { recursive: true });

async function discover([slug, name, id]) {
  const context = await chromium.launchPersistentContext(`${rootDir}/.club-profiles/${slug}`, {
    channel: "chrome", headless: true,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    let contactsResponse;
    page.on("response", (response) => {
      if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) contactsResponse = response;
    });
    await page.goto(`${appBase}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    for (let attempt = 0; attempt < 30 && !contactsResponse; attempt += 1) await page.waitForTimeout(500);
    if (!contactsResponse) throw new Error("Sin sesión de datos");
    const rawHeaders = await contactsResponse.request().allHeaders();
    const headers = Object.fromEntries(Object.entries(rawHeaders).filter(([key]) => !key.startsWith(":")));
    const clubId = `/onairespana/clubs/${id}`;
    const invoices = [];
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const params = new URLSearchParams({ clubId, "order[createdAt]": "desc", page: String(pageNumber) });
      const response = await context.request.get(`${apiBase}/invoices?${params}`, { headers: { ...headers, "x-user-club-id": clubId } });
      if (!response.ok()) throw new Error(`Facturas HTTP ${response.status()}`);
      const payload = await response.json();
      const members = payload["hydra:member"] ?? [];
      invoices.push(...members.filter((item) => item.createdAt?.slice(0, 10) >= monthStart && !item.canceledAt && !item.deletedAt && item.financialState !== "canceled"));
      const oldest = members.at(-1)?.createdAt?.slice(0, 10);
      if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < monthStart)) break;
    }
    const groups = new Map();
    for (const invoice of invoices) {
      for (const line of invoice.lines ?? []) {
        if (line.deletedAt) continue;
        const key = `${line.code ?? ""}|${line.name ?? ""}|${line.type ?? ""}`;
        const current = groups.get(key) ?? { code: line.code ?? null, name: line.name ?? null, type: line.type ?? null, count: 0, totalTI: 0 };
        current.count += 1;
        current.totalTI += Number(line.priceTI ?? 0);
        groups.set(key, current);
      }
    }
    return { slug, name, invoices: invoices.length, lines: [...groups.values()].map((row) => ({ ...row, totalTI: row.totalTI / 100 })).sort((a, b) => b.totalTI - a.totalTI) };
  } finally {
    await context.close();
  }
}

const results = [];
for (const club of clubs) results.push(await discover(club));
await writeFile(`${artifactsDir}/sales-kpi-discovery.json`, JSON.stringify({ generatedAt: new Date().toISOString(), monthStart, results }, null, 2));
console.log(JSON.stringify(results.map((club) => ({ slug: club.slug, invoices: club.invoices, lines: club.lines.length })), null, 2));
