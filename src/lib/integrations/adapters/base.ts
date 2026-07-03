import "server-only";
import { IntegrationScopeError } from "../errors";
import { getOAuthManager } from "../oauth/manager";
import { readState } from "../state/store";
import type { IntegrationState, ServiceDefinition } from "../types";

// Service adapters extend this base class. Subclasses implement service-
// specific methods (e.g. GmailAdapter.listMessages). All scope gating goes
// through `withScope` — adapter methods stay pure and the same error path is
// used everywhere so the CopilotKit action wrapper can surface consistent
// structured results.

export abstract class ServiceAdapter {
  constructor(
    protected readonly integrationId: string,
    protected readonly service: ServiceDefinition,
  ) {}

  /**
   * The effective scope set is the intersection of granted OAuth scopes and
   * the user's per-scope overrides. `spec.md §Scope Override UI Logic`:
   * - Scopes NOT in `granted_scopes` are never effective (regardless of override).
   * - Scopes IN `granted_scopes` are effective UNLESS overrides[scope] === false.
   * - No entry / true → effective.
   */
  static getEffectiveScopes(state: IntegrationState): Set<string> {
    const granted = state.oauthMeta?.granted_scopes ?? [];
    return new Set(granted.filter((s) => state.scopeOverrides[s] !== false));
  }

  protected async getState(): Promise<IntegrationState> {
    return readState(this.integrationId);
  }

  protected async getEffectiveScopes(): Promise<Set<string>> {
    return ServiceAdapter.getEffectiveScopes(await this.getState());
  }

  /** Throws IntegrationScopeError if `scope` is not effective; otherwise runs `fn`. */
  protected async withScope<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const effective = await this.getEffectiveScopes();
    if (!effective.has(scope)) {
      throw new IntegrationScopeError(scope, undefined, { integrationId: this.integrationId });
    }
    return fn();
  }

  /**
   * Fetch with a bearer token attached from OAuth manager. Retries once on
   * `401 Unauthorized` after forcing a token refresh — this covers the case
   * where the cached token happened to be revoked or expired unexpectedly.
   *
   * Public so shared HTTP clients (e.g. gsuiteFetch) can call through without
   * casting. Still server-only via this file's import gate.
   */
  async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (): Promise<Response> => {
      const token = await getOAuthManager().getValidToken(this.integrationId);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      return fetch(url, { ...init, headers });
    };
    let res = await attempt();
    if (res.status !== 401) return res;
    // Force refresh then retry once.
    await getOAuthManager().refreshToken(this.integrationId).catch(() => {});
    res = await attempt();
    return res;
  }
}
