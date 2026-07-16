#!/bin/sh
set -e

# ── Create "user" from CONTAINER_UID/CONTAINER_GID ──────────────────────────
# Arrives here as BOS_UID/BOS_GID — the bastion's own CONTAINER_UID/CONTAINER_GID,
# translated when it spawns this container. BOS runs as this account (not root,
# not the image's built-in "node") so files it writes to bind-mounted
# directories (data/) match the host user's uid/gid, avoiding permission
# conflicts. Defaults to 1000 (matching the bastion's own default) if unset,
# e.g. when running this image outside the bastion.
BOS_UID="${BOS_UID:-1000}"
BOS_GID="${BOS_GID:-1000}"
groupadd --gid "$BOS_GID" user
useradd --uid "$BOS_UID" --gid "$BOS_GID" --shell /bin/sh --home /home/user --create-home user

# Allow "user" to call bos-vfs-link as root without a password (narrow scope) —
# the Dockerfile's sudoers rule targets "user" by name; it just needs the
# account to exist by the time anything invokes sudo.

# Fix ownership of writable volumes/directories now that "user" exists.
# Only do a recursive chown when the top-level owner doesn't already match —
# avoids an expensive pass over node_modules on every restart.
#
# /app itself is the bind-mounted git checkout (owned by whoever the bastion
# ran `git clone`/`git pull` as on the host side — typically root, not "user").
# npm needs to write package-lock.json at its top level, so this needs fixing
# too, not just the node_modules/data volumes. The bastion's own git operations
# still work afterward regardless of this chown, since they run as root there
# (root ignores file ownership for read/write).
APP_OWNER=$(stat -c '%u' /app 2>/dev/null || echo "0")
if [ "$APP_OWNER" != "$BOS_UID" ]; then
  chown -R user:user /app
fi

NM_OWNER=$(stat -c '%u' /app/node_modules 2>/dev/null || echo "0")
if [ "$NM_OWNER" != "$BOS_UID" ]; then
  chown -R user:user /app/node_modules
fi

DATA_OWNER=$(stat -c '%u' /app/data 2>/dev/null || echo "0")
if [ "$DATA_OWNER" != "$BOS_UID" ]; then
  chown -R user:user /app/data
fi

chown user:user /home/user

# ── VFS symlinks for local-backend run_command ───────────────────────────────
# Create default VFS symlinks as root (before gosu drop) so run_command's local
# backend can write to /workspace and /Documents inside the BOS container.
# Runtime config changes are handled via sudo bos-vfs-link from the "user" process.
if [ -n "$BOS_DATA_DIR" ]; then
  for _dir in workspace Documents; do
    _target="$BOS_DATA_DIR/vfs/$_dir"
    _link="/$_dir"
    mkdir -p "$_target" 2>/dev/null || true
    chown -R user:user "$_target" 2>/dev/null || true
    # Only create/update if the path doesn't already exist as a non-symlink.
    if [ ! -e "$_link" ] || [ -L "$_link" ]; then
      ln -sfn "$_target" "$_link" 2>/dev/null || true
    fi
  done
fi

# ── npm install + main process (as user) ─────────────────────────────────────
echo "[bos] running npm install (uid=$BOS_UID gid=$BOS_GID)..."
gosu user npm install

exec gosu user "$@"
