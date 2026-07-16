#!/bin/sh
set -e

# ── UID/GID remapping ────────────────────────────────────────────────────────
# If BOS_UID / BOS_GID are provided, remap the 'bos' user so files written to
# bind-mounted directories (data/) are owned by the right host UID/GID.
# This runs as root; we drop to 'bos' before exec'ing the main process.

if [ -n "$BOS_GID" ]; then
  groupmod --gid "$BOS_GID" bos
fi
if [ -n "$BOS_UID" ]; then
  usermod --uid "$BOS_UID" bos
fi

# Fix ownership of writable volumes/directories.
# Only do a recursive chown when the top-level owner doesn't already match —
# avoids an expensive pass over node_modules on every restart.
BOS_UID_ACTUAL=$(id -u bos)
BOS_GID_ACTUAL=$(id -g bos)

NM_OWNER=$(stat -c '%u' /app/node_modules 2>/dev/null || echo "0")
if [ "$NM_OWNER" != "$BOS_UID_ACTUAL" ]; then
  chown -R bos:bos /app/node_modules
fi

DATA_OWNER=$(stat -c '%u' /app/data 2>/dev/null || echo "0")
if [ "$DATA_OWNER" != "$BOS_UID_ACTUAL" ]; then
  chown -R bos:bos /app/data
fi

chown bos:bos /home/bos

# ── npm install + main process (as bos) ─────────────────────────────────────
echo "[bos] running npm install (uid=$BOS_UID_ACTUAL gid=$BOS_GID_ACTUAL)..."
gosu bos npm install

exec gosu bos "$@"
