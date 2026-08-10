import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(rootDir, "artifacts");
const profileDir = process.env.BROWSER_PROFILE_DIR ?? `${rootDir}/.browser-profile-group`;
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com/onairespana";
const fallbackClubId = "/onairespana/clubs/3043";

const clubs = [
  ["barcelona", "Barcelona Universitat", "3046"],
  ["madrid", "Madrid Delicias", "3044"],
  ["malaga-armengual", "Málaga Armengual", "3045"],
  ["malaga-soho", "Málaga Soho", "3270"],
  ["les-arts", "Valencia Les Arts", "3041"],
  ["nuevo-centro", "Valencia Nuevo Centro", "3042"],
  ["ruzafa", "Valencia Ruzafa", "3043"],
];

const toLocalDay = (value) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date(value));

function cleanHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.startsWith(":")),
  );
}

function contactKey(contact) {
  return String(contact?.["@id"] ?? contact?.contactId ?? contact?.id ?? "");
}

await mkdir(artifactsDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: true,
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  let seedResponse = null;
  page.on("response", (response) => {
    if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) {
      seedResponse = response;
    }
  });

  await page.goto(`${appBase}/-/management/infinite-lists/memberships/members?clubId=${encodeURIComponent(fallbackClubId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  for (let attempt = 0; attempt < 40 && !seedResponse; attempt += 1) {
    await page.waitForTimeout(500);
  }
  if (!seedResponse) throw new Error("No se pudo capturar la sesión autenticada de Resamania.");

  const headers = cleanHeaders(await seedResponse.request().allHeaders());
  const clubHeaders = (clubId) => ({
    ...headers,
    origin: appBase,
    referer: `${appBase}/`,
    "x-user-club-id": clubId,
  });

  const clubsResponse = await context.request.get(`${apiBase}/clubs?visibility=local`, {
    headers: clubHeaders(fallbackClubId),
    timeout: 30000,
  });
  if (!clubsResponse.ok()) {
    throw new Error(`No se pudieron listar los clubes: HTTP ${clubsResponse.status()}`);
  }
  const clubsPayload = await clubsResponse.json();
  const availableClubs = (clubsPayload["hydra:member"] ?? [])
    .filter((club) => club?.["@id"] && club?.name)
    .map((club) => ({ clubId: club["@id"], name: club.name }));

  const clubMap = new Map(clubs.map(([slug, name, id]) => [`/onairespana/clubs/${id}`, { slug, name, id }]));
  for (const club of availableClubs) {
    if (!clubMap.has(club.clubId)) {
      clubMap.set(club.clubId, { slug: club.name, name: club.name, id: club.clubId.split("/").at(-1) ?? club.clubId });
    }
  }

  const collected = new Map();
  const perClub = [];

  for (const club of availableClubs.length ? availableClubs : clubs.map(([, name, id]) => ({ clubId: `/onairespana/clubs/${id}`, name }))) {
    const clubId = club.clubId;
    const clubName = club.name;
    const clubResult = { clubId, name: clubName, pages: 0, count: 0 };
    let pageNumber = 1;

    while (true) {
      const params = new URLSearchParams({
        clubId,
        isAnonymous: "false",
        includeNationalId: "true",
        "order[createdAt]": "desc",
        page: String(pageNumber),
        itemsPerPage: "100",
      });
      const response = await context.request.get(`${apiBase}/contacts?${params.toString()}`, {
        headers: clubHeaders(clubId),
        timeout: 45000,
      });
      if (!response.ok()) throw new Error(`${clubName}: HTTP ${response.status()} en page ${pageNumber}`);
      const payload = await response.json();
      const contacts = payload["hydra:member"] ?? [];
      clubResult.pages = pageNumber;
      clubResult.count += contacts.length;
      for (const contact of contacts) {
        const key = contactKey(contact);
        if (!key) continue;
        const existing = collected.get(key);
        const clubsSeen = new Set(existing?.clubs ?? []);
        clubsSeen.add(clubName);
        collected.set(key, {
          contactId: key,
          number: contact.number ?? existing?.number ?? null,
          givenName: contact.givenName ?? contact.firstname ?? existing?.givenName ?? null,
          familyName: contact.familyName ?? contact.lastname ?? existing?.familyName ?? null,
          email: contact.email ?? existing?.email ?? null,
          phone: contact.phone ?? existing?.phone ?? null,
          createdAt: contact.createdAt ?? existing?.createdAt ?? null,
          status: contact.status ?? existing?.status ?? null,
          clubs: [...clubsSeen],
        });
      }
      const oldest = contacts.at(-1)?.createdAt?.slice(0, 10);
      if (!payload["hydra:view"]?.["hydra:next"] || !contacts.length || (oldest && oldest < toLocalDay("2000-01-01"))) {
        break;
      }
      pageNumber += 1;
    }

    perClub.push(clubResult);
  }

  const rows = [...collected.values()].sort((a, b) => {
    const nameA = `${a.familyName ?? ""} ${a.givenName ?? ""}`.trim().toLowerCase();
    const nameB = `${b.familyName ?? ""} ${b.givenName ?? ""}`.trim().toLowerCase();
    return nameA.localeCompare(nameB, "es");
  });

  const output = {
    generatedAt: new Date().toISOString(),
    source: "Resamania /contacts",
    scope: "all-local-clubs",
    perClub,
    totalUniqueContacts: rows.length,
    contacts: rows,
  };

  await writeFile(join(artifactsDir, "lista-de-todos-los-clientes.json"), JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    generatedAt: output.generatedAt,
    clubs: perClub.length,
    totalUniqueContacts: output.totalUniqueContacts,
    file: join(artifactsDir, "lista-de-todos-los-clientes.json"),
  }, null, 2));
} finally {
  await context.close();
}
