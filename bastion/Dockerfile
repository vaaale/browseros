# Bastion — multi-stage build
# Stage 1: build the Vite React SPA
FROM node:20-alpine AS ui-build
WORKDIR /ui
COPY ui/package*.json ./
RUN npm install
COPY ui/ .
RUN npm run build

# Stage 2: compile TypeScript
FROM node:20-alpine AS ts-build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json .
COPY src/ src/
RUN npm run build

# Stage 3: production runtime
FROM node:20-alpine AS runtime
RUN apk add --no-cache git && \
    git config --global safe.directory '*'
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=ts-build /app/dist ./dist
COPY --from=ui-build /ui/dist ./ui/dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
