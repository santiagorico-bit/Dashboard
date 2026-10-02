#!/usr/bin/env bash
set -euo pipefail
cd /opt/onair/resamania-agent
exec /usr/bin/node src/sync-sftp-shadow.js
