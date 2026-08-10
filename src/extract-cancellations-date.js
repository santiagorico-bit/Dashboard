import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const targetDate = process.argv[2] ?? "2026-08-02";
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile`;
const appBase = "https://app.resamania.com/onairespana";
const apiUrl = "https://api.resamania.com/onairespana/cancellations";
const listUrl = `${appBase}/-/management/infinite-lists/memberships/cancellations`;

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: true,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("about:blank");
const firstResponsePromise = page.waitForResponse(
  (response) => response.url().startsWith(`${apiUrl}?`) && response.status() === 200,
  { timeout: 45000 },
);
await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
const firstResponse = await firstResponsePromise;
const requestHeaders = await firstResponse.request().allHeaders();
const headers = Object.fromEntries(
  Object.entries(requestHeaders).filter(([name]) => !name.startsWith(":")),
);
const motivesResponse = await context.request.get(
  "https://api.resamania.com/onairespana/referentials/cancellation_motives",
  { headers },
);
const motivesPayload = motivesResponse.ok() ? await motivesResponse.json() : {};
const motiveNames = new Map(
  (motivesPayload["hydra:member"] ?? []).map((motive) => [
    motive["@id"],
    motive.name ?? motive.label ?? motive.wording ?? motive["@id"],
  ]),
);

const matches = [];
let pageNumber = 1;
while (true) {
  const response = await context.request.get(
    `${apiUrl}?order%5BcreatedAt%5D=desc&page=${pageNumber}`,
    { headers },
  );
  if (!response.ok()) throw new Error(`Error ${response.status()} en página ${pageNumber}`);
  const payload = await response.json();
  const members = payload["hydra:member"] ?? [];
  matches.push(...members.filter((item) => item.createdAt === targetDate));
  const oldest = members.at(-1)?.createdAt;
  if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < targetDate)) break;
  pageNumber += 1;
}

const output = {
  generatedAt: new Date().toISOString(),
  targetDate,
  pagesRead: pageNumber,
  count: matches.length,
  matches: matches.map((item) => ({
    cancellationId: item["@id"],
    givenName: item.contact?.givenName ?? null,
    familyName: item.contact?.familyName ?? null,
    customerNumber: item.contact?.number ?? null,
    receptionDate: item.receptionDate ?? null,
    effectiveDate: item.cancellationDate ?? null,
    status: item.status ?? null,
    type: item.type ?? null,
    refundPolicy: item.refundPolicy ?? null,
    inputChannel: item.inputChannel ?? null,
    motive: motiveNames.get(item.cancellationMotiveId) ?? item.cancellationMotiveId ?? null,
    createdBy: item.createdBy ?? null,
    comment: item.comment ?? null,
  })),
};
await writeFile(
  `${artifactsDir}/cancellations-${targetDate}.json`,
  JSON.stringify(output, null, 2),
  "utf8",
);
console.log(`Páginas leídas: ${pageNumber}`);
console.log(`Bajas encontradas: ${matches.length}`);
await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
