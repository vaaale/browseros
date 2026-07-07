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
  dataDir: string;
  bosNet: string;
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
    volumeBase: process.env.VOLUME_BASE ?? persisted.volumeBase ?? "/user-data",
    idleTimeoutMs: parseInt(process.env.IDLE_TIMEOUT_MS ?? String(persisted.idleTimeoutMs ?? 1_800_000), 10),
    maxConcurrentInstances: parseInt(process.env.MAX_CONCURRENT_INSTANCES ?? String(persisted.maxConcurrentInstances ?? 50), 10),
    bosBaseRef: process.env.BOS_BASE_REF ?? persisted.bosBaseRef ?? "main",
    dataDir,
    bosNet: process.env.BOS_NET ?? "bos-net",
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
    "bosImage", "volumeBase", "idleTimeoutMs", "maxConcurrentInstances",
    "bosBaseRef", "bosNet", "keycloakIssuer", "keycloakClientId",
    "keycloakUsernameClaim", "keycloakAdminRole", "publicUrl",
  ];
  for (const key of allowed) {
    if (key in patch) (existing as Record<string, unknown>)[key] = patch[key];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}
