import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile`;
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com";
const reasonId = "/onairespana/referentials/blocking_reasons/91222";
const pilotClubId = "/onairespana/clubs/3042";

await mkdir(artifactsDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());

const pilotUrl = `${appBase}/-/management/infinite-lists/memberships/alerts?clubId=${encodeURIComponent(pilotClubId)}`;
await page.goto(pilotUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);

const clubChoice = page.getByText("On Air Valencia Nuevo Centro", { exact: true });
if (await clubChoice.isVisible().catch(() => false)) {
  await clubChoice.click({ force: true });
  await page.waitForTimeout(6000);
  await page.goto(pilotUrl, { waitUntil: "domcontentloaded" });
}

await page.waitForTimeout(7000);
await page.keyboard.press("Escape");
await page.evaluate(() => {
  for (const dialog of document.querySelectorAll("[role='dialog']")) {
    (dialog.closest(".MuiModal-root") ?? dialog).remove();
  }
  document.body.style.overflow = "";
});

const filteredResponsePromise = page.waitForResponse(
  (response) =>
    response.url().includes("/alerts?") &&
    response.url().includes("blockingReasonId") &&
    response.status() === 200,
  { timeout: 30000 },
);

const reasonSelect = page.getByText("Todos los motivos", { exact: true });
await reasonSelect.focus();
await reasonSelect.press("ArrowDown");
const missingMandate = page.getByText("Falta el mandato", { exact: true });
await missingMandate.waitFor({ state: "visible", timeout: 10000 });
await missingMandate.evaluate((element) => element.click());

const filteredResponse = await filteredResponsePromise;
const requestHeaders = filteredResponse.request().headers();
const authorization = requestHeaders.authorization;
if (!authorization) throw new Error("No se pudo recuperar la autorización de la sesión.");
const authenticatedHeaders = {
  ...requestHeaders,
  authorization,
  origin: appBase,
  referer: `${appBase}/`,
};

const nodesResponse = await context.request.get(`${apiBase}/onairespana/network_nodes`, {
  headers: authenticatedHeaders,
});
if (!nodesResponse.ok()) throw new Error(`No se pudieron listar clubes: ${nodesResponse.status()}`);
const nodesPayload = await nodesResponse.json();
const clubs = nodesPayload["hydra:member"]
  .filter((node) => node.type === "club" && node.clubId)
  .map((node) => ({ name: node.name, clubId: node.clubId }));

const orderedClubs = [
  ...clubs.filter((club) => club.clubId === pilotClubId),
  ...clubs.filter((club) => club.clubId !== pilotClubId),
];
const results = [];
let currentClubName = "On Air Valencia Nuevo Centro";
let currentFilteredResponse = filteredResponse;

for (const club of orderedClubs) {
  if (club.clubId !== pilotClubId) {
    await page.keyboard.press("Escape");
    const clubSwitchControl = page.getByText("power_settings_new", { exact: true }).last();
    await clubSwitchControl.click({ force: true });
    await page.waitForTimeout(1500);
    const targetClub = page.getByText(club.name, { exact: true }).last();
    await targetClub.waitFor({ state: "visible", timeout: 10000 });
    await targetClub.click({ force: true });
    await page.waitForTimeout(7000);

    const clubAlertsUrl = `${appBase}/-/management/infinite-lists/memberships/alerts?clubId=${encodeURIComponent(club.clubId)}`;
    await page.goto(clubAlertsUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(7000);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      for (const dialog of document.querySelectorAll("[role='dialog']")) {
        (dialog.closest(".MuiModal-root") ?? dialog).remove();
      }
      document.body.style.overflow = "";
    });

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/alerts?") &&
        response.url().includes("blockingReasonId") &&
        response.status() === 200,
      { timeout: 30000 },
    );
    const select = page.getByText("Todos los motivos", { exact: true });
    await select.focus();
    await select.press("ArrowDown");
    const option = page.getByText("Falta el mandato", { exact: true });
    await option.waitFor({ state: "visible", timeout: 10000 });
    await option.evaluate((element) => element.click());
    currentFilteredResponse = await responsePromise;
    currentClubName = club.name;
  }

  const clubHeaders = {
    ...currentFilteredResponse.request().headers(),
    origin: appBase,
    referer: `${appBase}/`,
  };
  const alerts = [];
  let pageNumber = 1;
  while (true) {
    const params = new URLSearchParams({
      clubId: club.clubId,
      blockingReasonId: reasonId,
      "order[id]": "desc",
      page: String(pageNumber),
    });
    const response = await context.request.get(
      `${apiBase}/onairespana/alerts?${params.toString()}`,
      { headers: clubHeaders },
    );
    if (!response.ok()) {
      throw new Error(`${club.name}: error ${response.status()} al consultar alertas`);
    }
    const payload = await response.json();
    alerts.push(...(payload["hydra:member"] ?? []));
    if (!payload["hydra:view"]?.["hydra:next"]) break;
    pageNumber += 1;
  }
  results.push({
    club: club.name,
    clubId: club.clubId,
    count: alerts.length,
    users: alerts.map((alert) => ({
      contactId: alert.contact?.["@id"] ?? null,
      customerNumber: alert.contact?.number ?? null,
      givenName: alert.contact?.givenName ?? null,
      familyName: alert.contact?.familyName ?? null,
      createdAt: alert.createdAt ?? null,
      blockingDate: alert.blockingDate ?? null,
      blocking: Boolean(alert.blockingDate),
      content: alert.content ?? null,
    })),
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  criterion: { reason: "Falta el mandato", status: "En curso" },
  total: results.reduce((sum, club) => sum + club.count, 0),
  clubs: results,
};
await writeFile(
  `${artifactsDir}/missing-mandates.json`,
  JSON.stringify(output, null, 2),
  "utf8",
);

console.log(`Clubes consultados: ${results.length}`);
console.log(`Incidencias encontradas: ${output.total}`);
console.log(`Resultado guardado en ${artifactsDir}/missing-mandates.json`);
await context.close();
