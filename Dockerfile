# BrowserOS user-container image
# Runs the Supervisor on port 8090. Per-user data is mounted at BOS_DATA_DIR.
# node_modules are populated by docker-entrypoint.sh on first start if absent
# (supports a per-user named volume for mutable dependencies).
#
# This image doubles as the run_command local sandbox environment (FR-024):
# it bundles the same runtimes as docker/run-command/Dockerfile so that
# run_command works inside a user container without a separate image.
# Package selection mirrors docker/run-command/Dockerfile exactly so both
# backends produce identical skill behaviour.
#
# Approx compressed image size: ~1.5–2 GB (LibreOffice ~400 MB, Python stack
# ~150 MB, Claude Code + OpenCode ~200 MB, BOS source + Node.js base ~300 MB).
# If > 3 GB is a concern, build a slim variant that omits LibreOffice.

#FROM node:20-alpine AS runtime
FROM node:trixie AS runtime

# System packages — all in one layer to minimise image size.
# LibreOffice requires OpenJDK on Alpine; we include the headless JRE only.
RUN apt-get update && apt-get install -y \
    git ca-certificates \
    gosu \
    sudo \
    python3 \
    python3-venv \
    poppler-utils \
    libreoffice \
    openjdk-25-jre-headless \
    fonts-dejavu fonts-liberation

# node:trixie ships a "node" user/group at uid/gid 1000 by default. BOS itself
# runs as a DIFFERENT account, "user" — created fresh by docker-entrypoint.sh
# at container start from CONTAINER_UID/CONTAINER_GID (== the bastion's env
# vars, passed through as BOS_UID/BOS_GID), so it matches the host user and
# bind-mounted files don't end up owned by a foreign uid. Since CONTAINER_UID
# commonly defaults to 1000 (the host's first non-root user), "node" at 1000
# would collide with useradd trying to create "user" at that same id —
# renumber "node" out of the way here so 1000 stays free for "user".
RUN groupmod --gid 5000 node && \
    usermod --uid 5000 --gid 5000 node && \
    chown -R 5000:5000 /home/node

# Python tooling lives in a virtualenv, NOT the system interpreter.
# Alpine's system Python is "externally managed" (PEP 668) — bare pip installs
# fail. A venv on PATH makes python/pip/ipython resolve to it transparently.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Match the package set from docker/run-command/Dockerfile so local-backend
# run_command behaves identically to the Docker-backend sandbox.
RUN pip install --no-cache-dir \
    ipython \
    "markitdown[all]" \
    Pillow \
    python-pptx \
    docx

# pptxgenjs is a Node package (used by run_command skills for pptx generation).
# Make it resolvable from /workspace scripts via NODE_PATH.
RUN npm install -g pptxgenjs docx xlsx-populate
ENV NODE_PATH=/usr/local/lib/node_modules

# bos-vfs-link: narrow privileged helper that lets the non-root "user" process
# create/remove VFS symlinks at absolute paths for the local-backend run_command.
# Validates that the link is absolute and the target is absolute before acting.
RUN printf '#!/bin/bash\nset -e\nACTION="$1"; LINK="$2"; TARGET="$3"\ncase "$LINK" in /*) ;; *) echo "bos-vfs-link: link must be absolute" >&2; exit 1 ;; esac\nif [ "$ACTION" = "add" ]; then\n  [ -z "$TARGET" ] && { echo "bos-vfs-link: target required" >&2; exit 1; }\n  case "$TARGET" in /*) ;; *) echo "bos-vfs-link: target must be absolute" >&2; exit 1 ;; esac\n  mkdir -p "$TARGET"\n  ln -sfn "$TARGET" "$LINK"\nelif [ "$ACTION" = "remove" ]; then\n  [ -L "$LINK" ] && rm "$LINK"\nelse\n  echo "Usage: bos-vfs-link (add|remove) <link> [target]" >&2; exit 1\nfi\n' > /usr/local/bin/bos-vfs-link && chmod 755 /usr/local/bin/bos-vfs-link

# Allow the "user" account (created at runtime by docker-entrypoint.sh) to call
# bos-vfs-link as root without a password (narrow scope). The rule is name-based —
# sudoers doesn't need "user" to exist yet at build time, only by the time it's invoked.
RUN echo "user ALL=(root) NOPASSWD: /usr/local/bin/bos-vfs-link" > /etc/sudoers.d/bos-vfs-link \
    && chmod 440 /etc/sudoers.d/bos-vfs-link

WORKDIR /app

# Copy source (node_modules excluded by .dockerignore)
COPY . .

# Install Claude Code and OpenCode CLIs globally
RUN npm install -g @anthropic-ai/claude-code opencode-ai

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8090

# BOS_DATA_DIR is set by the bastion when spawning containers (/app/data).
# The Supervisor listens on 8090.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "tools/supervisor/supervisor.mjs"]
