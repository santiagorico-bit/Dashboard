import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile-group`;
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com/onairespana";
const clubs = [
  ["Barcelona Universitat", "/onairespana/clubs/3046"],
  ["Madrid Delicias", "/onairespana/clubs/3044"],
  ["Málaga Armengual", "/onairespana/clubs/3045"],
  ["Málaga Soho", "/onairespana/clubs/3270"],
  ["Valencia Les Arts", "/onairespana/clubs/3041"],
  ["Valencia Nuevo Centro", "/onairespana/clubs/3042"],
  ["Valencia Ruzafa", "/onairespana/clubs/3043"],
];

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: true,
});
const page = context.pages()[0] ?? (await context.newPage());
const capturedUrls = [];
let dataResponse = null;
page.on("response", (response) => {
  if (["xhr", "fetch"].includes(response.request().resourceType())) {
    capturedUrls.push({ status: response.status(), url: response.url() });
  }
  if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) {
    dataResponse = response;
  }
});
await page.goto("about:blank");
await page.goto(
  `${appBase}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F3042`,
  { waitUntil: "domcontentloaded", timeout: 45000 },
);
await page.waitForTimeout(20000);
const bodyText = await page.locator("body").innerText();
if (!dataResponse) {
  await writeFile(
    `${artifactsDir}/group-access-test.json`,
    JSON.stringify({ checkedAt: new Date().toISOString(), bodyText, capturedUrls }, null, 2),
    "utf8",
  );
  console.log("No se cargó la colección de contactos; diagnóstico guardado.");
  await context.close();
  process.exit(2);
}
const rawHeaders = await dataResponse.request().allHeaders();
const baseHeaders = Object.fromEntries(
  Object.entries(rawHeaders).filter(([name]) => !name.startsWith(":")),
);

const results = [];
for (const [name, clubId] of clubs) {
  const url = `${apiBase}/contacts?clubId=${encodeURIComponent(clubId)}&order%5BcreatedAt%5D=desc&page=1`;
  const response = await context.request.get(url, {
    headers: { ...baseHeaders, "x-user-club-id": clubId },
  });
  let count = null;
  if (response.ok()) {
    const payload = await response.json();
    count = payload["hydra:member"]?.length ?? null;
  }
  results.push({ name, clubId, status: response.status(), firstPageCount: count });
}

await writeFile(
  `${artifactsDir}/group-access-test.json`,
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
  "utf8",
);
console.log(JSON.stringify(results, null, 2));
await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
