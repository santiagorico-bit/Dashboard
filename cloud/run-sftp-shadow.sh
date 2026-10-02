#!/bin/sh
set -eu

ROOT=/opt/onair-agent
PROJECT_ID=total-name-510214-j0

export RESAMANIA_SFTP_HOST=ssh.cluster131.hosting.ovh.net
export RESAMANIA_SFTP_PORT=22
export RESAMANIA_SFTP_USER=squadni-resa
export RESAMANIA_SFTP_PATH=.
export RESAMANIA_SFTP_MAX_FILES=12
export RESAMANIA_SFTP_HOST_FINGERPRINT=SHA256:ry5S7obJV8ofKcdC3TCg0U/O11IGxQAEKHNkxImOgJ8,SHA256:N4DQHF8Pzfs8s5/QgV8tEx5NgKZeghhkDfpnO+ZG7Fo
export RESAMANIA_SFTP_PASSWORD
RESAMANIA_SFTP_PASSWORD="$(gcloud secrets versions access latest --secret=onair-resamania-sftp-password --project="$PROJECT_ID")"
export RESAMANIA_SFTP_INGEST_TOKEN
RESAMANIA_SFTP_INGEST_TOKEN="$(gcloud secrets versions access latest --secret=onair-resamania-sftp-ingest-token --project="$PROJECT_ID")"
export RESAMANIA_SFTP_INGEST_URL=https://estwazokbjrguvfvbohd.supabase.co/functions/v1/ingest-resamania-sftp
export SUPABASE_PUBLISHABLE_KEY
SUPABASE_PUBLISHABLE_KEY="$(node -e "const c=require('$ROOT/artifacts/club-kpi-publisher.json'); process.stdout.write(c.apiKey)")"

cd "$ROOT"
exec node src/sync-sftp-shadow.js
