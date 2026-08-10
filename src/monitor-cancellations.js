import { chromium } from "playwright";
import { appendFile, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = `${rootDir}/.browser-profile`;
const stateFile = `${artifactsDir}/cancellation-monitor-state.json`;
const logFile = `${artifactsDir}/ruzafa-cancellations-first-seen.jsonl`;
const lockFile = `${artifactsDir}/cancellation-monitor.lock`;
const listUrl =
  "https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/cancellations";
const clubId = "/onairespana/clubs/3043";
const clubName = "On Air Valencia Ruzafa";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

await mkdir(artifactsDir, { recursive: true });
let lock;
try {
  lock = await open(lockFile, "wx");
} catch (error) {
  if (error.code === "EEXIST") {
    const lockAgeMs = Date.now() - (await stat(lockFile)).mtimeMs;
    if (lockAgeMs < 120_000) process.exit(0);
    await unlink(lockFile);
    lock = await open(lockFile, "wx");
  } else {
    throw error;
  }
}

let context;
try {
  let state = { initialized: false, seenIds: [] };
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {}
  const seen = new Set(state.seenIds ?? []);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: true,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("about:blank");

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().startsWith("https://api.resamania.com/onairespana/cancellations?") &&
      response.status() === 200,
    { timeout: 45000 },
  );
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  const response = await responsePromise;
  const payload = await response.json();
  const members = payload["hydra:member"] ?? [];
  const detectedAt = new Date().toISOString();
  const isBaseline = !state.initialized;

  const newRecords = members
    .filter(
      (item) =>
        item.clubId === clubId ||
        item.createdAt === today ||
        item.receptionDate === today,
    )
    .filter((item) => !seen.has(item["@id"]))
    .map((item) => ({
      cancellationId: item["@id"],
      club: clubName,
      firstSeenAt: detectedAt,
      baseline: isBaseline,
      createdDate: item.createdAt ?? null,
      receptionDate: item.receptionDate ?? null,
      effectiveDate: item.cancellationDate ?? null,
      status: item.status ?? null,
      refundPolicy: item.refundPolicy ?? null,
      customerNumber: item.contact?.number ?? null,
      givenName: item.contact?.givenName ?? null,
      familyName: item.contact?.familyName ?? null,
      createdBy: item.createdBy ?? null,
      motiveId: item.cancellationMotiveId ?? null,
    }));

  if (newRecords.length) {
    await appendFile(
      logFile,
      `${newRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
  }
  for (const item of members) seen.add(item["@id"]);
  await writeFile(
    stateFile,
    JSON.stringify(
      {
        initialized: true,
        lastSuccessfulRunAt: detectedAt,
        seenIds: [...seen].slice(-5000),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`${detectedAt} | nuevas=${newRecords.length} | baseline=${isBaseline}`);
} catch (error) {
  const failedAt = new Date().toISOString();
  await appendFile(
    `${artifactsDir}/cancellation-monitor-errors.log`,
    `${failedAt} | ${error.message}\n`,
    "utf8",
  );
  process.exitCode = 1;
} finally {
  if (context) await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  await lock?.close();
  await unlink(lockFile).catch(() => {});
}
