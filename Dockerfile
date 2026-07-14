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

FROM node:20-alpine AS runtime

# System packages — all in one layer to minimise image size.
# LibreOffice requires OpenJDK on Alpine; we include the headless JRE only.
RUN apk add --no-cache \
    git \
    python3 \
    py3-virtualenv \
    poppler-utils \
    libreoffice \
    openjdk17-jre-headless \
    font-dejavu

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
    "markitdown[pptx]" \
    Pillow \
    python-pptx \
    docx

# pptxgenjs is a Node package (used by run_command skills for pptx generation).
# Make it resolvable from /workspace scripts via NODE_PATH.
RUN npm install -g pptxgenjs
ENV NODE_PATH=/usr/local/lib/node_modules

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
