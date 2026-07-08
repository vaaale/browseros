#!/bin/sh
set -e

# Always run npm install so dependencies stay in sync with the source clone.
# This is a no-op when package-lock.json hasn't changed (npm uses its cache).
echo "[bos] running npm install..."
npm install

exec "$@"
