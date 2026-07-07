import { Issuer, generators } from "openid-client";
import type { Client } from "openid-client";
import type { Config } from "../config";
import type { AuthProvider, UserRecord } from "./index";

export class KeycloakProvider implements AuthProvider {
  private cfg: Config;
  private _client: Client | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private async client(): Promise<Client> {
    if (this._client) return this._client;
    const issuer = await Issuer.discover(this.cfg.keycloakIssuer);
    this._client = new issuer.Client({
      client_id: this.cfg.keycloakClientId,
      client_secret: this.cfg.keycloakClientSecret,
      response_types: ["code"],
    });
    return this._client;
  }

  getAuthorizationUrl(state: string, redirectUri: string): Promise<string>;
  async getAuthorizationUrl(state: string, redirectUri: string): Promise<string> {
    const client = await this.client();
    return client.authorizationUrl({
      scope: "openid profile email",
      state,
      code_challenge: generators.codeChallenge(state),
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
    });
  }

  async handleCallback(
    params: Record<string, string>,
    redirectUri: string,
    state: string,
  ): Promise<UserRecord | null> {
    const client = await this.client();
    try {
      const tokenSet = await client.callback(redirectUri, params, {
        state,
        code_verifier: state,
      });
      const claims = tokenSet.claims();
      const username = (claims[this.cfg.keycloakUsernameClaim] as string) ?? "";
      if (!/^[a-z0-9_-]+$/.test(username)) return null;

      const roles: string[] =
        (claims["realm_access"] as { roles?: string[] } | undefined)?.roles ?? [];
      const isAdmin = roles.includes(this.cfg.keycloakAdminRole);
      return { username, isAdmin };
    } catch {
      return null;
    }
  }

  // Write operations not supported for Keycloak (IdP manages users)
  async authenticate(_u: string, _p: string): Promise<UserRecord | null> {
    throw new Error("Direct authentication not supported for Keycloak provider — use OIDC flow");
  }
  async getUser(_username: string): Promise<UserRecord | null> { return null; }
  async listUsers(): Promise<UserRecord[]> { return []; }
  async createUser(): Promise<void> { throw new Error("User management not supported for Keycloak provider"); }
  async deleteUser(): Promise<void> { throw new Error("User management not supported for Keycloak provider"); }
  async updatePassword(): Promise<void> { throw new Error("Password management not supported for Keycloak provider"); }
  async setAdmin(): Promise<void> { throw new Error("Role management not supported for Keycloak provider"); }
}
