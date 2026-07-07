# BrowserOS — Docker image
# Runs the Supervisor on port 8090. Per-user data is mounted at BOS_DATA_DIR.
# node_modules are populated by docker-entrypoint.sh on first start if absent
# (supports a per-user named volume for mutable dependencies).

FROM node:20-alpine AS runtime
WORKDIR /app

# Copy source (node_modules excluded by .dockerignore)
COPY . .

# Install dependencies into the image as a warm cache.
# docker-entrypoint.sh will re-run npm install if the user's per-user
# named volume is empty (first start), so this layer just avoids a cold
# install on every container start for users that haven't changed deps.
RUN npm install

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8090

# BOS_DATA_DIR is set by the bastion when spawning containers (/app/data).
# The Supervisor listens on 8090.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "tools/supervisor/supervisor.mjs"]
