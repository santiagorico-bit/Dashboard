import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "csv-parse";
import SftpClient from "ssh2-sftp-client";
import { entityFromFilename, isCsvFile, mapRecord, sha256File } from "./sftp-shadow-domain.js";
import { createPostgresStore } from "./sftp-postgres-store.js";

const required = ["RESAMANIA_SFTP_HOST", "RESAMANIA_SFTP_USER", "RESAMANIA_SFTP_PASSWORD", "RESAMANIA_SFTP_HOST_FINGERPRINT"];
for (const key of required) if (!process.env[key]) throw new Error(`Falta ${key}`);

const endpoint = process.env.RESAMANIA_SFTP_INGEST_URL;
const ingestToken = process.env.RESAMANIA_SFTP_INGEST_TOKEN;
const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const postgresStore = process.env.DATABASE_URL ? createPostgresStore() : null;
if (!postgresStore && (!endpoint || !ingestToken)) throw new Error("Falta DATABASE_URL o la configuración HTTP de ingestión");
const remoteRoot = process.env.RESAMANIA_SFTP_PATH || ".";
const maxFiles = Math.max(1, Math.min(100, Number(process.env.RESAMANIA_SFTP_MAX_FILES || 12)));
const includeInitialExports = process.env.RESAMANIA_SFTP_INCLUDE_INIT === "true";
const initialExportEntities = new Set((process.env.RESAMANIA_SFTP_INIT_ENTITIES || "")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
const maxAgeHours = Math.max(0, Number(process.env.RESAMANIA_SFTP_MAX_AGE_HOURS || 0));
const chunkSize = 400;
const isInitialExport = (filename) => /(?:^|[_-])init\d*(?:[_\-.]|$)/i.test(filename);
const isPrioritizedInitialExport = (filename) => isInitialExport(filename)
  && initialExportEntities.has(entityFromFilename(filename));
const normalizeFingerprint = (value) => value.trim().replace(/^SHA256:/, "").replace(/=+$/, "");
const trustedHostFingerprints = new Set(process.env.RESAMANIA_SFTP_HOST_FINGERPRINT.split(",").map(normalizeFingerprint));
const verifyHostKey = (key) => {
  const fingerprint = normalizeFingerprint(createHash("sha256").update(key).digest("base64"));
  if (!trustedHostFingerprints.has(fingerprint)) console.error(`[SFTP] Huella de host no reconocida: SHA256:${fingerprint}`);
  return trustedHostFingerprints.has(fingerprint);
};

async function ingest(action, body = {}, attempts = 3) {
  if (postgresStore) return postgresStore.ingest(action, body);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-token": ingestToken, ...(apiKey ? { apikey: apiKey } : {}) },
        body: JSON.stringify({ action, ...body }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function processCsv(path, entity, fileId, runId) {
  const parser = createReadStream(path).pipe(parse({ columns: true, delimiter: ";", bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true }));
  let chunk = [];
  let rowCount = 0;
  for await (const record of parser) {
    chunk.push(mapRecord(entity, record, rowCount));
    rowCount += 1;
    if (chunk.length >= chunkSize) {
      await ingest("upsert_chunk", { runId, fileId, entity, rows: chunk });
      chunk = [];
    }
  }
  if (chunk.length) await ingest("upsert_chunk", { runId, fileId, entity, rows: chunk });
  return rowCount;
}

const sftp = new SftpClient("onair-resamania-shadow");
const tempDirectory = await fs.mkdtemp(join(tmpdir(), "onair-sftp-"));
let runId;
let filesSeen = 0;
let filesProcessed = 0;
let failedFiles = 0;
let rowsUpserted = 0;

try {
  const started = await ingest("run_start", { metadata: { mode: "shadow", host: process.env.RESAMANIA_SFTP_HOST } });
  runId = started.runId;
  await sftp.connect({
    host: process.env.RESAMANIA_SFTP_HOST,
    port: Number(process.env.RESAMANIA_SFTP_PORT || 22),
    username: process.env.RESAMANIA_SFTP_USER,
    password: process.env.RESAMANIA_SFTP_PASSWORD,
    readyTimeout: 30_000,
    hostVerifier: verifyHostKey,
  });
  const catalog = await ingest("file_catalog", { runId });
  const processedFiles = new Map((catalog.files ?? []).map((file) => [file.remote_path, file]));
  // Current operational deltas must always win the processing budget. Large
  // `_init` exports run only in an explicit backfill lane; including them in
  // the hourly job can consume the timeout before live KPIs are published.
  const listed = (await sftp.list(remoteRoot))
    .filter(isCsvFile)
    .filter((item) => {
      const isInitial = isInitialExport(item.name);
      return !isInitial || includeInitialExports || initialExportEntities.has(entityFromFilename(item.name));
    })
    .filter((item) => isPrioritizedInitialExport(item.name)
      || !maxAgeHours
      || Number(item.modifyTime || 0) >= Date.now() - maxAgeHours * 60 * 60 * 1000)
    .sort((a, b) => {
      // Explicitly requested INIT entities seed authoritative state (for
      // example active memberships). Process them before deltas so the
      // bounded hourly budget cannot starve the base dataset.
      const priority = Number(isPrioritizedInitialExport(b.name)) - Number(isPrioritizedInitialExport(a.name));
      return priority || Number(b.modifyTime || 0) - Number(a.modifyTime || 0);
    });
  filesSeen = listed.length;
  for (const item of listed) {
    if (filesProcessed >= maxFiles) break;
    const remotePath = remoteRoot === "." ? item.name : `${remoteRoot.replace(/\/$/, "")}/${item.name}`;
    const known = processedFiles.get(remotePath);
    const remoteModifiedAt = item.modifyTime ? new Date(item.modifyTime).getTime() : 0;
    const knownModifiedAt = known?.remote_modified_at ? new Date(known.remote_modified_at).getTime() : 0;
    // A delta export can legitimately keep the same byte size while its rows
    // change. Only skip it when both size and SFTP modification time match.
    // SFTP servers and PostgreSQL do not always retain the same sub-second
    // precision. Treat timestamps within one second as the same file so an
    // unchanged delta is not needlessly downloaded and replayed every hour.
    const sameModifiedAt = remoteModifiedAt > 0 && knownModifiedAt > 0 && Math.abs(remoteModifiedAt - knownModifiedAt) < 1000;
    if (known && Number(known.remote_size) === Number(item.size || 0) && sameModifiedAt) continue;
    const localPath = join(tempDirectory, basename(item.name));
    const entity = entityFromFilename(item.name);
    let fileId;
    try {
      await sftp.fastGet(remotePath, localPath);
      const sha256 = await sha256File(localPath);
      const begun = await ingest("file_begin", { runId, entity, sha256, filename: item.name, remotePath, remoteSize: Number(item.size || 0), remoteModifiedAt: item.modifyTime ? new Date(item.modifyTime).toISOString() : null });
      fileId = begun.fileId;
      if (begun.skip) continue;
      const rowCount = await processCsv(localPath, entity, fileId, runId);
      await ingest("file_complete", { runId, fileId, rowCount });
      filesProcessed += 1;
      rowsUpserted += rowCount;
    } catch (error) {
      failedFiles += 1;
      if (fileId) await ingest("file_fail", { runId, fileId, error: error.message }).catch(() => {});
      console.error(`[SFTP] ${item.name}: ${error.message}`);
    } finally {
      await fs.rm(localPath, { force: true });
    }
  }
  await ingest("run_complete", { runId, filesSeen, filesProcessed, failedFiles, rowsUpserted });
  console.log(JSON.stringify({ ok: failedFiles === 0, mode: "shadow", filesSeen, filesProcessed, failedFiles, rowsUpserted }));
} catch (error) {
  if (runId) await ingest("run_fail", { runId, filesSeen, filesProcessed, rowsUpserted, error: error.message }).catch(() => {});
  throw error;
} finally {
  await sftp.end().catch(() => {});
  await fs.rm(tempDirectory, { recursive: true, force: true });
  await postgresStore?.close().catch(() => {});
}
