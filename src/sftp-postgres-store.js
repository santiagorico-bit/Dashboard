import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const schema = `
CREATE TABLE IF NOT EXISTS resamania_sync_runs (
  id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, files_seen integer NOT NULL DEFAULT 0, files_processed integer NOT NULL DEFAULT 0,
  rows_upserted integer NOT NULL DEFAULT 0, error text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS resamania_sftp_files (
  id uuid PRIMARY KEY, run_id uuid REFERENCES resamania_sync_runs(id) ON DELETE SET NULL,
  remote_path text NOT NULL, filename text NOT NULL, entity text NOT NULL, sha256 text NOT NULL UNIQUE,
  remote_size bigint NOT NULL, remote_modified_at timestamptz, status text NOT NULL DEFAULT 'processing',
  row_count integer NOT NULL DEFAULT 0, error text, first_seen_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS resamania_sftp_files_status_idx ON resamania_sftp_files(status, remote_modified_at DESC);
CREATE TABLE IF NOT EXISTS resamania_sftp_records (
  entity text NOT NULL, external_uid text NOT NULL, club_code text, contact_uid text,
  occurred_at timestamptz, source_updated_at timestamptz, source_deleted_at timestamptz,
  source_file_id uuid NOT NULL REFERENCES resamania_sftp_files(id), payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(entity, external_uid)
);
CREATE INDEX IF NOT EXISTS resamania_sftp_records_club_entity_idx ON resamania_sftp_records(club_code, entity);
CREATE INDEX IF NOT EXISTS resamania_sftp_records_occurred_idx ON resamania_sftp_records(entity, occurred_at DESC);
CREATE TABLE IF NOT EXISTS club_kpi_snapshots (
  club_code text NOT NULL, club_name text NOT NULL, snapshot_date date NOT NULL,
  collected_at timestamptz NOT NULL, source text NOT NULL, metrics jsonb NOT NULL,
  PRIMARY KEY(club_code, snapshot_date, collected_at)
);
CREATE INDEX IF NOT EXISTS club_kpi_snapshots_latest_idx ON club_kpi_snapshots(club_code, snapshot_date DESC, collected_at DESC);
`;

const text = (value, max = 500) => value == null ? null : String(value).slice(0, max);
const timestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export function createPostgresStore(connectionString = process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString, ssl: connectionString?.includes("localhost") ? false : { rejectUnauthorized: false }, max: 4 });
  let ready;
  const initialize = () => ready ??= (async () => {
    let lastError;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        await pool.query(schema);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 30) await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, attempt * 1000)));
      }
    }
    throw lastError;
  })();
  const query = async (...args) => { await initialize(); return pool.query(...args); };

  return {
    pool,
    initialize,
    close: () => pool.end(),
    async ingest(action, body = {}) {
      if (action === "run_start") {
        const runId = randomUUID();
        await query("INSERT INTO resamania_sync_runs(id, metadata) VALUES ($1, $2)", [runId, body.metadata ?? {}]);
        return { ok: true, runId };
      }
      const runId = text(body.runId, 80);
      if (!runId) throw new Error("Invalid runId");
      if (action === "file_catalog") {
        const { rows } = await query("SELECT remote_path, remote_size, remote_modified_at, status FROM resamania_sftp_files WHERE status='processed' ORDER BY remote_modified_at DESC LIMIT 5000");
        return { ok: true, files: rows };
      }
      if (action === "file_begin") {
        const existing = await query("SELECT id,status,row_count FROM resamania_sftp_files WHERE sha256=$1", [body.sha256]);
        if (existing.rows[0]?.status === "processed") return { ok: true, skip: true, fileId: existing.rows[0].id, rowCount: existing.rows[0].row_count };
        const fileId = existing.rows[0]?.id ?? randomUUID();
        await query(`INSERT INTO resamania_sftp_files(id,run_id,remote_path,filename,entity,sha256,remote_size,remote_modified_at,status,error)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'processing',NULL)
          ON CONFLICT(sha256) DO UPDATE SET run_id=EXCLUDED.run_id,remote_path=EXCLUDED.remote_path,filename=EXCLUDED.filename,
          entity=EXCLUDED.entity,remote_size=EXCLUDED.remote_size,remote_modified_at=EXCLUDED.remote_modified_at,status='processing',error=NULL`,
          [fileId, runId, text(body.remotePath, 1000), text(body.filename), body.entity, body.sha256, Number(body.remoteSize ?? 0), timestamp(body.remoteModifiedAt)]);
        return { ok: true, skip: false, fileId };
      }
      if (action === "upsert_chunk") {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const row of rows) await client.query(`INSERT INTO resamania_sftp_records
            (entity,external_uid,club_code,contact_uid,occurred_at,source_updated_at,source_deleted_at,source_file_id,payload,ingested_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(entity,external_uid) DO UPDATE SET
            club_code=EXCLUDED.club_code,contact_uid=EXCLUDED.contact_uid,occurred_at=EXCLUDED.occurred_at,
            source_updated_at=EXCLUDED.source_updated_at,source_deleted_at=EXCLUDED.source_deleted_at,
            source_file_id=EXCLUDED.source_file_id,payload=EXCLUDED.payload,ingested_at=now()`,
            [body.entity, text(row.externalUid, 300), text(row.clubCode, 80), text(row.contactUid, 300), timestamp(row.occurredAt), timestamp(row.sourceUpdatedAt), timestamp(row.sourceDeletedAt), body.fileId, row.payload ?? {}]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
        return { ok: true, upserted: rows.length };
      }
      if (action === "file_complete" || action === "file_fail") {
        const failed = action === "file_fail";
        await query("UPDATE resamania_sftp_files SET status=$1,row_count=$2,error=$3,processed_at=$4 WHERE id=$5 AND run_id=$6",
          [failed ? "failed" : "processed", Math.max(0, Number(body.rowCount ?? 0)), failed ? text(body.error, 2000) : null, failed ? null : new Date(), body.fileId, runId]);
        return { ok: true };
      }
      if (action === "run_complete" || action === "run_fail") {
        const failed = action === "run_fail";
        await query("UPDATE resamania_sync_runs SET status=$1,completed_at=now(),files_seen=$2,files_processed=$3,rows_upserted=$4,error=$5 WHERE id=$6",
          [failed ? "failed" : Number(body.failedFiles ?? 0) ? "partial" : "completed", Number(body.filesSeen ?? 0), Number(body.filesProcessed ?? 0), Number(body.rowsUpserted ?? 0), failed ? text(body.error, 2000) : null, runId]);
        return { ok: true };
      }
      throw new Error(`Unknown action: ${action}`);
    },
  };
}
