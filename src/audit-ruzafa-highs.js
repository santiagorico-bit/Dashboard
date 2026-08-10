import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3043";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const monthStart = `${today.slice(0, 8)}01`;
const context = await chromium.launchPersistentContext(`${rootDir}/.browser-profile-group`, {
  channel: "chrome",
  headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://app.resamania.com/onairespana", {
    waitUntil: "domcontentloaded", timeout: 45000,
  });
  const targetClub = page.getByRole("button", { name: "On Air Valencia Ruzafa", exact: true });
  if (!(await targetClub.isVisible().catch(() => false))) {
    const clubButton = page.getByRole("button", { name: "Club", exact: true });
    if (await clubButton.isVisible().catch(() => false)) await clubButton.click();
  }
  await targetClub.waitFor({ state: "visible", timeout: 15000 });
  await targetClub.click();
  await page.waitForTimeout(1500);
  let seed;
  page.on("response", (response) => {
    if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response;
  });
  await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3043", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  for (let attempt = 0; attempt < 30 && !seed; attempt += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión de Ruzafa");
  const rawHeaders = await seed.request().allHeaders();
  const headers = {
    ...Object.fromEntries(Object.entries(rawHeaders).filter(([key]) => !key.startsWith(":"))),
    "x-user-club-id": clubId,
  };
  const subscriptions = [];
  for (let pageNumber = 1; pageNumber <= 30; pageNumber += 1) {
    const params = new URLSearchParams({
      "contact.clubId": clubId,
      "order[validFrom]": "desc",
      page: String(pageNumber),
    });
    const response = await context.request.get(`${apiBase}/subscriptions?${params}`, { headers });
    if (!response.ok()) throw new Error(`Abonos HTTP ${response.status()}`);
    const payload = await response.json();
    const members = payload["hydra:member"] ?? [];
    subscriptions.push(...members.filter((item) => item.validFrom?.slice(0, 10) >= monthStart));
    const oldest = members.at(-1)?.validFrom?.slice(0, 10);
    if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < monthStart)) break;
  }
  const rows = subscriptions.map((item) => ({
    id: item["@id"],
    contactId: item.contactId ?? item.contact?.["@id"],
    number: item.contact?.number,
    name: item.name ?? item.initialInfo?.productName,
    code: item.initialInfo?.productCode,
    offer: item.initialInfo?.offerName ?? item.offer?.name,
    createdAt: item.createdAt,
    validFrom: item.validFrom,
    validThrough: item.validThrough,
    terminatedAt: item.terminatedAt,
    consumed: item.consumed,
    state: item.state,
    status: item.status,
    enabled: item.enabled,
    keys: Object.keys(item).sort(),
  }));
  const invoices = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const params = new URLSearchParams({
      clubId,
      "order[createdAt]": "desc",
      itemsPerPage: "100",
      page: String(pageNumber),
    });
    const response = await context.request.get(`${apiBase}/invoices?${params}`, { headers });
    if (!response.ok()) throw new Error(`Facturas HTTP ${response.status()}`);
    const payload = await response.json();
    const members = payload["hydra:member"] ?? [];
    invoices.push(...members.filter((item) => item.createdAt?.slice(0, 10) >= monthStart));
    const oldest = members.at(-1)?.createdAt?.slice(0, 10);
    if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < monthStart)) break;
  }
  const sessionRows = rows.filter((row) => String(row.name).toLocaleLowerCase("es").includes("sesión"));
  const sessionContacts = new Set(sessionRows.map((row) => row.contactId).filter(Boolean));
  const sessionInvoices = invoices
    .filter((invoice) => sessionContacts.has(invoice.contactId ?? invoice.contact?.["@id"]))
    .map((invoice) => ({
      id: invoice["@id"],
      contactId: invoice.contactId ?? invoice.contact?.["@id"],
      createdAt: invoice.createdAt,
      status: invoice.status ?? invoice.state ?? invoice.financialState,
      canceledAt: invoice.canceledAt,
      totalTI: invoice.totalTI,
      lines: (invoice.lines ?? []).map((line) => ({
        code: line.code,
        name: line.name ?? line.label ?? line.description,
        quantity: line.quantity,
        priceTI: line.priceTI,
        articleId: line.articleId ?? line.article?.["@id"],
        subscriptionId: line.subscriptionId ?? line.subscription?.["@id"],
      })),
    }));
  const grouped = Object.values(rows.reduce((result, row) => {
    const key = [row.validFrom?.slice(0, 10), row.code, row.name, row.state, row.status, row.terminatedAt ? "terminated" : "open"].join("|");
    result[key] ??= {
      date: row.validFrom?.slice(0, 10), code: row.code, name: row.name,
      state: row.state, status: row.status, termination: row.terminatedAt ? "terminated" : "open",
      subscriptions: 0, contacts: new Set(),
    };
    result[key].subscriptions += 1;
    if (row.contactId) result[key].contacts.add(row.contactId);
    return result;
  }, {})).map((row) => ({ ...row, contacts: row.contacts.size }));
  const output = {
    generatedAt: new Date().toISOString(), club: "Valencia Ruzafa",
    rows, grouped, sessionRows, sessionInvoices,
  };
  await writeFile(`${rootDir}/artifacts/ruzafa-highs-audit.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(grouped, null, 2));
} finally {
  await context.close();
}
