import fs from "fs";
import path from "path";

export interface Config {
  port: number;
  jwtSecret: string;
  authProvider: "simple" | "keycloak";
  bosImage: string;
  volumeBase: string;
  idleTimeoutMs: number;
  maxConcurrentInstances: number;
  bosBaseRef: string;
  bosRepoPath: string;
  /** HOST-absolute equivalent of `volumeBase`, used to construct bind-mount
   *  sources for spawned user containers (Docker always resolves bind mounts
   *  against the host filesystem, never the bastion's own). `loadConfig()`
   *  sets a best-effort placeholder; `resolveOwnMountSource()` in docker.ts
   *  overwrites it at startup with the value self-discovered from the
   *  bastion's own container mounts (024 FR-020) — no env var for this. */
  bosVolumeBaseHost: string;
  /** When set, mount this HOST path directly at /app instead of creating a
   *  per-user clone. Feature branches created inside the container are
   *  immediately visible in the host repo. Intended for single-developer
   *  setups where the repo is on the same machine as the Docker host. */
  bosRepoHostPath?: string;
  dataDir: string;
  bosNet: string;
  /** UID/GID the BOS process runs as inside user containers. Passed as
   *  BOS_UID / BOS_GID env vars; the entrypoint remaps the 'node' account and
   *  drops privileges before starting the app. Unset = image default uid/gid 5000. */
  containerUid?: number;
  containerGid?: number;
  // Keycloak OIDC
  keycloakIssuer: string;
  keycloakClientId: string;
  keycloakClientSecret: string;
  keycloakUsernameClaim: string;
  keycloakAdminRole: string;
  publicUrl: string;
}

function readPersistedConfig(dataDir: string): Partial<Config> {
  const file = path.join(dataDir, "config.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as Partial<Config>;
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const dataDir = process.env.BASTION_DATA_DIR ?? "/data";
  const persisted = readPersistedConfig(dataDir);

  const jwtSecret = process.env.JWT_SECRET ?? persisted.jwtSecret ?? "";
  if (!jwtSecret) {
    throw new Error("[bastion] JWT_SECRET env var is required but not set");
  }

  const rawProvider = process.env.AUTH_PROVIDER ?? persisted.authProvider ?? "simple";
  if (rawProvider !== "simple" && rawProvider !== "keycloak") {
    throw new Error(`[bastion] AUTH_PROVIDER must be 'simple' or 'keycloak', got '${rawProvider}'`);
  }

  return {
    port: parseInt(process.env.PORT ?? "3000", 10),
    jwtSecret,
    authProvider: rawProvider,
    bosImage: process.env.BOS_IMAGE ?? persisted.bosImage ?? "browseros:latest",
    // Fixed convention, not an env var: this is always the bastion's own
    // internal mount point for its per-user volumes (docker-compose.yml's
    // `volumes:` line always mounts them at /user-data). The operator-facing
    // knob for WHERE this lives on the host is the compose file's own
    // `${VOLUME_BASE:-./user-data}:/user-data` bind-mount source, resolved
    // relative to the compose file's directory — never this constant.
    volumeBase: "/user-data",
    idleTimeoutMs: parseInt(process.env.IDLE_TIMEOUT_MS ?? String(persisted.idleTimeoutMs ?? 1_800_000), 10),
    maxConcurrentInstances: parseInt(process.env.MAX_CONCURRENT_INSTANCES ?? String(persisted.maxConcurrentInstances ?? 50), 10),
    bosBaseRef: process.env.BOS_BASE_REF ?? persisted.bosBaseRef ?? "main",
    bosRepoPath: process.env.BOS_REPO_PATH ?? persisted.bosRepoPath ?? "/bos-src",
    // Placeholder — overwritten at startup by self-discovery (see docker.ts's
    // resolveOwnMountSource, called from index.ts). Only used as-is when that
    // discovery fails (not running in a container, e.g. local dev), in which
    // case "the host path" and "this process's own filesystem" are the same
    // thing anyway, so a cwd-relative resolution is correct.
    bosVolumeBaseHost: path.resolve("user-data"),
    bosRepoHostPath: process.env.BOS_REPO_HOST_PATH || persisted.bosRepoHostPath || undefined,
    dataDir,
    bosNet: process.env.BOS_NET ?? "bos-net",
    containerUid: process.env.CONTAINER_UID ? parseInt(process.env.CONTAINER_UID, 10) : undefined,
    containerGid: process.env.CONTAINER_GID ? parseInt(process.env.CONTAINER_GID, 10) : undefined,
    keycloakIssuer: process.env.KEYCLOAK_ISSUER ?? "",
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID ?? "",
    keycloakClientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? "",
    keycloakUsernameClaim: process.env.KEYCLOAK_USERNAME_CLAIM ?? "preferred_username",
    keycloakAdminRole: process.env.KEYCLOAK_ADMIN_ROLE ?? "bos-admin",
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:3000",
  };
}

export function saveConfig(dataDir: string, patch: Partial<Config>): void {
  const file = path.join(dataDir, "config.json");
  let existing: Partial<Config> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
  } catch { /* start fresh */ }
  const allowed: (keyof Config)[] = [
    "bosBaseRef", "bosRepoPath", "bosNet", "keycloakIssuer", "keycloakClientId",
    "keycloakUsernameClaim", "keycloakAdminRole", "publicUrl",
  ];
  for (const key of allowed) {
    if (key in patch) (existing as Record<string, unknown>)[key] = patch[key];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}
