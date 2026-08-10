import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile`;
const appBase = "https://app.resamania.com/onairespana";
const apiUrl = "https://api.resamania.com/onairespana/cancellations";
const listUrl = `${appBase}/-/management/infinite-lists/memberships/cancellations`;
const fromDate = "2026-01-01";

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("about:blank");
const firstResponsePromise = page.waitForResponse(
  (response) => response.url().startsWith(`${apiUrl}?`) && response.status() === 200,
  { timeout: 30000 },
);
await page.goto(listUrl, { waitUntil: "domcontentloaded" });
const firstResponse = await firstResponsePromise;
const requestHeaders = await firstResponse.request().allHeaders();
const headers = {
  ...Object.fromEntries(
    Object.entries(requestHeaders).filter(([name]) => !name.startsWith(":")),
  ),
  origin: appBase,
  referer: `${appBase}/`,
};
if (!headers.authorization) {
  throw new Error(`La petición no expuso autorización. Cabeceras: ${Object.keys(headers).join(", ")}`);
}

const cancellations = [];
let pageNumber = 1;
while (true) {
  const response = await context.request.get(
    `${apiUrl}?order%5BcreatedAt%5D=desc&page=${pageNumber}`,
    { headers },
  );
  if (!response.ok()) throw new Error(`Error ${response.status()} en página ${pageNumber}`);
  const payload = await response.json();
  const members = payload["hydra:member"] ?? [];
  cancellations.push(...members);
  const oldest = members.at(-1)?.createdAt;
  if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < fromDate)) break;
  pageNumber += 1;
}

const matches = cancellations
  .filter(
    (item) =>
      item.createdAt >= fromDate &&
      item.refundPolicy === "period_start",
  )
  .map((item) => ({
    givenName: item.contact?.givenName ?? null,
    familyName: item.contact?.familyName ?? null,
    customerNumber: item.contact?.number ?? null,
    createdAt: item.createdAt ?? null,
    cancellationDate: item.cancellationDate ?? null,
    status: item.status ?? null,
    type: item.type ?? null,
    inputChannel: item.inputChannel ?? null,
    motiveId: item.cancellationMotiveId ?? null,
    createdBy: item.createdBy ?? null,
    comment: item.comment ?? null,
  }));

const output = {
  generatedAt: new Date().toISOString(),
  club: "On Air Valencia Ruzafa",
  criteria: {
    createdFrom: fromDate,
    refundPolicy: "Período actual completo",
  },
  pagesRead: pageNumber,
  count: matches.length,
  matches,
};
await writeFile(
  `${artifactsDir}/ruzafa-cancellations-period-current.json`,
  JSON.stringify(output, null, 2),
  "utf8",
);
console.log(`Páginas leídas: ${pageNumber}`);
console.log(`Bajas encontradas: ${matches.length}`);
await context.close();
