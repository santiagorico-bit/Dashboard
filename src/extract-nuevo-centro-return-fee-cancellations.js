import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = process.env.BROWSER_PROFILE_DIR ?? `${rootDir}/.browser-profile-group`;
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3042";
const from = "2026-07-01";
const to = "2026-08-31";
const returnFeePattern = /(rejet|rejection|rechazo|retard|retraso|devoluc|dossier|prélèvement|prellev|return fee)/i;
await mkdir(artifactsDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome", headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(appBase, { waitUntil: "domcontentloaded", timeout: 60000 });
  const target = page.getByRole("button", { name: "On Air Valencia Nuevo Centro", exact: true });
  if (!(await target.isVisible().catch(() => false))) {
    const selector = page.getByRole("button", { name: "Club", exact: true });
    if (await selector.isVisible().catch(() => false)) await selector.click();
  }
  await target.waitFor({ state: "visible", timeout: 15000 });
  await target.click();
  await page.waitForTimeout(1200);
  let captured;
  page.on("response", (response) => {
    if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) captured = response;
  });
  await page.goto(`${appBase}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3042`, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 30 && !captured; i += 1) await page.waitForTimeout(500);
  if (!captured) throw new Error("No se pudo obtener la sesión de datos de Nuevo Centro");
  const rawHeaders = await captured.request().allHeaders();
  const headers = Object.fromEntries(Object.entries(rawHeaders).filter(([name]) => !name.startsWith(":")));
  const cancellations = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const params = new URLSearchParams({
      "contact.clubId": clubId,
      "cancellationDate[after]": from,
      "cancellationDate[before]": to,
      "order[cancellationDate]": "desc",
      itemsPerPage: "100",
      page: String(pageNumber),
    });
    const response = await context.request.get(`${apiBase}/cancellations?${params}`, { headers, timeout: 60000 });
    if (!response.ok()) throw new Error(`Bajas HTTP ${response.status()}`);
    const payload = await response.json();
    cancellations.push(...(payload["hydra:member"] ?? []));
    if (!payload["hydra:view"]?.["hydra:next"]) break;
  }
  const matches = [];
  for (const cancellation of cancellations.filter((item) =>
    item.cancellationDate?.slice(0, 10) >= from && item.cancellationDate?.slice(0, 10) <= to &&
    !/cancel/i.test(item.status ?? "") && /traitement automatique|consumer/i.test(item.createdBy ?? "")
  )) {
    const contactId = cancellation.contact?.["@id"] ?? cancellation.contactId;
    if (!contactId) continue;
    const params = new URLSearchParams({ contactId, "order[createdAt]": "desc", itemsPerPage: "100", page: "1" });
    const response = await context.request.get(`${apiBase}/invoices?${params}`, { headers, timeout: 60000 });
    if (!response.ok()) continue;
    const invoices = (await response.json())["hydra:member"] ?? [];
    const returnFeeInvoices = invoices.filter((invoice) => {
      if (invoice.canceledAt || invoice.deletedAt) return false;
      if (Number(invoice.totalTI ?? 0) !== 800) return false;
      if (Number(invoice.totalTI ?? 0) - Number(invoice.totalPaid ?? 0) <= 0) return false;
      if (invoice.rejectionFee !== true) return false;
      const lineText = (invoice.lines ?? []).map((line) => [
        line.name,
        line.description,
        line.code,
      ].filter(Boolean).join(" ")).join(" ");
      return returnFeePattern.test(lineText);
    });
    if (returnFeeInvoices.length !== 2) continue;
    const nonTrivialInvoices = invoices.filter((invoice) =>
      !invoice.canceledAt && !invoice.deletedAt && Number(invoice.totalTI ?? 0) - Number(invoice.totalPaid ?? 0) > 0
    );
    if (nonTrivialInvoices.length !== 2) continue;
    const hasFullRefund = invoices.some((invoice) => {
      const creditNotes = [...(invoice.usedCreditNotes ?? []), ...(invoice.issuedCreditNotes ?? [])];
      return creditNotes.some((creditNote) => Number(creditNote.amount ?? creditNote.totalTI ?? 0) > 0) ||
        (invoice.refunds === true && Number(invoice.totalTI ?? 0) > 0);
    });
    if (hasFullRefund) continue;
    matches.push({
      name: [cancellation.contact?.givenName, cancellation.contact?.familyName].filter(Boolean).join(" ") || null,
      customerNumber: cancellation.contact?.number ?? null,
      requestedAt: cancellation.receptionDate ?? cancellation.createdAt ?? null,
      effectiveAt: cancellation.cancellationDate ?? null,
      createdBy: cancellation.createdBy ?? null,
      cancellationId: cancellation["@id"],
    });
  }
  const output = { generatedAt: new Date().toISOString(), club: "Valencia Nuevo Centro", period: { from, to }, count: matches.length, matches };
  await writeFile(`${artifactsDir}/nuevo-centro-return-fee-cancellations-jul-aug.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  await context.close();
}
