# Sandbox image for BrowserOS `run_command` (Docker backend).
#
# Bundles the runtimes BOS skills expect:
#   - python3 + ipython, markitdown[pptx], Pillow  (docx/pptx/xlsx/pdf skills)
#   - node + pptxgenjs                             (pptx "create from scratch")
#   - LibreOffice (soffice) + poppler (pdftoppm)   (document -> pdf -> image)
#   - common fonts
#
# Runs as non-root uid 1000 to match the executor's `--user 1000:1000`. The
# executor bind-mounts a per-(session,agent) host dir at /workspace (rw) and runs
# commands via `docker exec`; when a skill is used its files are staged INTO
# /workspace so SKILL.md's relative paths (e.g. `python scripts/office/unpack.py`)
# resolve verbatim.
#
# Build:   docker build -t browseros/run-command:latest docker/run-command
# Configure: Settings -> Command Execution -> Docker image = browseros/run-command:latest
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      libreoffice \
      poppler-utils \
      fonts-dejavu fonts-liberation \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# PEP 668: this is a dedicated sandbox image, so installing into the system
# environment is intentional.
RUN pip3 install --no-cache-dir --break-system-packages \
      ipython \
      "markitdown[pptx]" \
      Pillow

RUN npm install -g pptxgenjs

# node:22-bookworm already ships a uid 1000 user; just make /workspace writable.
RUN mkdir -p /workspace && chown 1000:1000 /workspace
WORKDIR /workspace
USER 1000:1000

# Kept alive by the executor; commands run via `docker exec`.
CMD ["sleep", "infinity"]
