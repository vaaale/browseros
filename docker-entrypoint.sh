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
# Idempotent: a plain `docker start` on an already-provisioned container reuses
# its existing writable layer — /etc/passwd and /etc/group persist across
# stop/start, unlike a full destroy+recreate which gets a fresh one — so "user"
# may already exist from a prior start. Skip re-creating it in that case rather
# than letting groupadd/useradd's "already exists" exit codes trip `set -e`.
# Previously this forced every plain restart into the bastion's expensive
# recreate-container fallback (fresh chown -R + npm install) instead of a cheap
# start, since the container never got far enough to reuse its existing state.
if ! getent group user >/dev/null 2>&1; then
  groupadd --gid "$BOS_GID" user
fi
if ! id user >/dev/null 2>&1; then
  useradd --uid "$BOS_UID" --gid "$BOS_GID" --shell /bin/sh --home /home/user --create-home user
fi

# Allow "user" to call bos-vfs-link as root without a password (narrow scope) —
# the Dockerfile's sudoers rule targets "user" by name; it just needs the
# account to exist by the time anything invokes sudo.

# Fix ownership of writable volumes/directories now that "user" exists.
#
# /app is the bind-mounted git checkout. The bastion runs git operations as root
# (git clone, git reset --hard) between container starts, which rechowns individual
# files (including package-lock.json) back to root even when the /app directory
# itself remains owned by "user". Always chown the whole tree — node_modules is a
# separate Docker volume so this only traverses the source tree and is fast.
chown -R user:user /app

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
