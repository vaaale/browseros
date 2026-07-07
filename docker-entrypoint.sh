#!/bin/sh
set -e

# Install dependencies if node_modules is absent (e.g. fresh named volume).
if [ ! -f /app/node_modules/.bin/next ]; then
  echo "[bos] node_modules not found — running npm install..."
  npm install
fi

exec "$@"
