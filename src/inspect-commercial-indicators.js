import { chromium } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const apiBase = "https://api.resamania.com/onairespana";
const clubId = "/onairespana/clubs/3041";
const audit = JSON.parse(await readFile(`${rootDir}/artifacts/les-arts-memberships-audit.json`, "utf8"));
const sessionContacts = [...new Set(audit.rows.filter((row) => row.code === "sesion").map((row) => row.contactId))].slice(0, 8);
const context = await chromium.launchPersistentContext(`${rootDir}/.club-profiles/les-arts`, { channel: "chrome", headless: true });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  let seed;
  page.on("response", (response) => { if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) seed = response; });
  await page.goto("https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3041", { waitUntil: "domcontentloaded", timeout: 45000 });
  for (let i = 0; i < 30 && !seed; i += 1) await page.waitForTimeout(500);
  if (!seed) throw new Error("Sin sesión");
  const raw = await seed.request().allHeaders();
  const headers = { ...Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith(":"))), "x-user-club-id": clubId };
  const get = async (url) => {
    try {
      const response = await context.request.get(url, { headers, timeout: 10000 });
      let payload = null; try { payload = await response.json(); } catch {}
      return { status: response.status(), payload };
    } catch (error) { return { status: "timeout", error: error.message.split("\n")[0] }; }
  };
  const results = [];
  const sources = await get(`${apiBase}/referentials/sources`);
  const cancellationSample = await get(`${apiBase}/cancellations?clubId=${encodeURIComponent(clubId)}&order%5BcreatedAt%5D=desc&page=1`);
  const cancellationSubscriptions = [];
  for (const cancellation of (cancellationSample.payload?.["hydra:member"] ?? []).slice(0, 8)) {
    cancellationSubscriptions.push({
      cancellation: {
        createdAt: cancellation.createdAt,
        subscription: cancellation.subscription,
        contact: cancellation.contact?.["@id"],
      },
      detail: await get(`${apiBase}/subscriptions?contact=${encodeURIComponent(cancellation.contact?.["@id"] ?? "")}&page=1`),
    });
  }
  for (const contactId of sessionContacts) {
    const id = contactId.split("/").at(-1);
    const detail = await get(`${apiBase}/contacts/${id}`);
    const invoices = await get(`${apiBase}/invoices?contactId=${encodeURIComponent(contactId)}&order%5BcreatedAt%5D=desc&page=1`);
    const subscriptions = await get(`${apiBase}/subscriptions?contact=${encodeURIComponent(contactId)}&order%5BvalidFrom%5D=desc&page=1`);
    const references = {};
    for (const endpoint of ["referrals", "references", "contact_references", "sponsorships"]) {
      references[endpoint] = await get(`${apiBase}/${endpoint}?contactId=${encodeURIComponent(contactId)}&page=1`);
    }
    results.push({ contactId, detail, invoices, subscriptions, references });
  }
  await writeFile(`${rootDir}/artifacts/commercial-indicators-inspection.json`, JSON.stringify({ generatedAt: new Date().toISOString(), sources, cancellationSample, cancellationSubscriptions, results }, null, 2));
  console.log(JSON.stringify(results.map((row) => ({ contactId: row.contactId, detailKeys: Object.keys(row.detail.payload ?? {}), invoiceCount: row.invoices.payload?.["hydra:member"]?.length, subscriptionCount: row.subscriptions.payload?.["hydra:member"]?.length, referenceStatuses: Object.fromEntries(Object.entries(row.references).map(([key, value]) => [key, value.status])) })), null, 2));
} finally { await context.close(); }
