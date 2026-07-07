# BrowserOS — Docker image
# Runs the Supervisor on port 8090. Per-user data is mounted at BOS_DATA_DIR.
# node_modules are populated by docker-entrypoint.sh on first start if absent
# (supports a per-user named volume for mutable dependencies).

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS runtime
WORKDIR /app

# Source and dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Remove anything that shouldn't be in the image
RUN rm -rf .next bastion data user-data

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8090

# BOS_DATA_DIR is set by the bastion when spawning containers (/app/data).
# The Supervisor listens on 8090.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "tools/supervisor/supervisor.mjs"]
