# BrowserOS user-container image
# Runs the Supervisor on port 8090. Per-user data is mounted at BOS_DATA_DIR.
# node_modules are populated by docker-entrypoint.sh on first start if absent
# (supports a per-user named volume for mutable dependencies).
#
# This image doubles as the run_command local sandbox environment (FR-024):
# it bundles the same runtimes as docker/run-command/Dockerfile so that
# run_command works inside a user container without a separate image.
#
# Approx compressed image size: ~1.5–2 GB (LibreOffice ~400 MB, Python stack
# ~150 MB, Claude Code + OpenCode ~200 MB, BOS source + Node.js base ~300 MB).
# If > 3 GB is a concern, build a slim variant that omits LibreOffice.

FROM node:20-alpine AS runtime

# Install system packages in a single layer to keep image size down.
# apt cache is cleaned to avoid bloating the layer.
RUN apk add --no-cache \
    git \
    python3 \
    py3-pip \
    py3-virtualenv \
    poppler-utils \
    # LibreOffice for document conversion (run_command skills)
    libreoffice \
    # Runtime deps for LibreOffice on Alpine
    openjdk17-jre-headless \
    font-dejavu \
    # Build tools needed for some pip packages
    gcc \
    musl-dev \
    python3-dev \
    libffi-dev

# Python packages for run_command skills
RUN python3 -m pip install --no-cache-dir \
    python-pptx \
    pptxgenjs \
    requests \
    pillow

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
