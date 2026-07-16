# Sandbox image for BrowserOS `run_command` (Docker backend).
#
# Bundles the runtimes BOS skills expect:
#   - python3 + ipython, markitdown[pptx], Pillow  (docx/pptx/xlsx/pdf skills)
#   - node + pptxgenjs                             (pptx "create from scratch")
#   - LibreOffice (soffice) + poppler (pdftoppm)   (document -> pdf -> image)
#   - common fonts
#
# Runs as an ARBITRARY uid:gid, chosen at container-creation time by the
# executor (`--user $CONTAINER_UID:$CONTAINER_GID`, numeric — matches the host
# user so bind-mounted files don't end up owned by a foreign uid). No account
# is created for this identity; Docker doesn't require one for a numeric
# --user. Because the uid is unknown at build time, every writable path below
# is made world-writable instead of chown'd to a fixed id.
#
# The executor bind-mounts a per-(session,agent) host dir at /workspace (rw) and runs
# commands via `docker exec`; when a skill is used its files are staged INTO
# /workspace so SKILL.md's relative paths (e.g. `python scripts/office/unpack.py`)
# resolve verbatim.
#
# Build:   docker build -t browseros/run-command:latest docker/run-command
# Configure: Settings -> Command Execution -> Docker image = browseros/run-command:latest
#FROM node:22-bookworm
FROM node:trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      libreoffice \
      poppler-utils \
      fonts-dejavu fonts-liberation \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python tooling lives in a virtualenv, NOT the system interpreter. On Debian the
# system Python is "externally managed" (PEP 668), so `pip install` there fails
# unless forced — the exact error agents hit. A venv on PATH makes python/pip/
# ipython resolve to it, so plain `pip install <pkg>` just works at runtime.
# World-writable (not chown'd) since the runtime uid is arbitrary and unknown here.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
RUN pip install --no-cache-dir ipython "markitdown[all]" Pillow python-pptx docx \
 && chmod -R a+rwX "$VIRTUAL_ENV"

RUN npm install -g pptxgenjs docx xlsx-populate

# Make globally-installed node modules (pptxgenjs) resolvable by scripts run from
# /workspace, and keep python output unbuffered so the idle watchdog sees progress.
ENV NODE_PATH=/usr/local/lib/node_modules
ENV PYTHONUNBUFFERED=1

# /workspace is world-writable for the same reason — the executor's --user is
# only known at `docker run` time, not at build time.
RUN mkdir -p /workspace && chmod a+rwX /workspace
WORKDIR /workspace

# Kept alive by the executor; commands run via `docker exec --user $CONTAINER_UID:$CONTAINER_GID`.
CMD ["sleep", "infinity"]
