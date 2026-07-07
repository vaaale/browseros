import type { Config } from "../config";

export interface UserRecord {
  username: string;
  isAdmin: boolean;
}

export interface AuthProvider {
  authenticate(username: string, password: string): Promise<UserRecord | null>;
  getUser(username: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  createUser(username: string, password: string, isAdmin: boolean): Promise<void>;
  deleteUser(username: string): Promise<void>;
  updatePassword(username: string, newPassword: string): Promise<void>;
  setAdmin(username: string, isAdmin: boolean): Promise<void>;
}

export async function loadProvider(cfg: Config): Promise<AuthProvider> {
  if (cfg.authProvider === "simple") {
    const { SimpleProvider } = await import("./simple");
    return new SimpleProvider(cfg);
  }
  if (cfg.authProvider === "keycloak") {
    const { KeycloakProvider } = await import("./keycloak");
    return new KeycloakProvider(cfg);
  }
  throw new Error(`Unknown auth provider: ${cfg.authProvider}`);
}
