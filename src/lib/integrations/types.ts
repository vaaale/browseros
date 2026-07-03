// Framework-free types for the integrations subsystem. Safe to import from
// client OR server code — no `server-only`, no Node imports, no React.
//
// Shape follows specs/user-specs/integrations-framework/spec.md §Architecture.
// OAuth wire fields keep their snake_case names (RFC 6749); BOS-owned fields
// use camelCase to match the rest of the codebase.

/**
 * Permissive JSON-Schema alias. Phase 1 does not validate config against a
 * schema library — this is here so manifests can declare a shape without the
 * subsystem taking a dependency. Tighten to a real JSON-Schema type later if
 * we start validating.
 */
export type JSONSchema = Record<string, unknown>;

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  /** All scopes this integration is *able* to request — a superset of any
   *  single service's `scopes`. */
  supportedScopes: string[];
}

export interface ServiceDefinition {
  /** Stable id, e.g. "gmail". Unique within an integration. */
  id: string;
  name: string;
  description: string;
  /** OAuth scopes this service needs to function at all. */
  scopes: string[];
  /** lucide-react icon name, e.g. "Mail". Optional; defaults to the
   *  integration's icon. */
  icon?: string;
  /** Per-service configuration shape (used by the settings UI). */
  configSchema: JSONSchema;
}

export interface IntegrationManifest {
  /** Stable id, e.g. "gsuite". */
  id: string;
  name: string;
  version: string;
  description: string;
  /** lucide-react icon name. */
  icon: string;
  services: ServiceDefinition[];
  oauthConfig: OAuthConfig;
}

/**
 * Full OAuth token bundle as returned by a provider's token endpoint.
 * Persisted ONLY in SecretsStore — never in a state.json. Field names
 * mirror the OAuth 2.0 wire format so token responses can be parsed
 * with minimal transformation.
 */
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** Absolute epoch milliseconds; derived from `expires_in`. */
  expires_at: number;
  granted_scopes: string[];
}

/**
 * Non-sensitive projection of {@link OAuthTokens} that IS safe to persist
 * outside the SecretsStore (i.e. in state.json). Contains no access or
 * refresh token material.
 */
export interface OAuthTokenMetadata {
  expires_at: number;
  granted_scopes: string[];
}

export interface IntegrationServiceState {
  /** User-enabled. May be false even when OAuth has granted the scopes. */
  enabled: boolean;
  /** Per-service config, shape defined by the service's `configSchema`. */
  config: Record<string, unknown>;
  /** Last successful sync/poll, epoch millis. */
  lastSync?: number;
  /** Last error surfaced by this service (for the UI). */
  error?: string;
}

export interface IntegrationState {
  connected: boolean;
  /** Epoch millis of the last successful OAuth connect. */
  lastConnected?: number;
  /** Per-service state, keyed by `ServiceDefinition.id`. */
  services: Record<string, IntegrationServiceState>;
  /**
   * User overrides for individual scopes. `true` = enabled, `false` = user
   * disabled. Only scopes present in `oauthMeta.granted_scopes` may be set
   * to `false`; scopes not granted cannot be forced on.
   */
  scopeOverrides: Record<string, boolean>;
  /**
   * Non-sensitive mirror of the OAuth token metadata. The real access +
   * refresh tokens live in the SecretsStore under `tokens:<integrationId>`.
   */
  oauthMeta?: OAuthTokenMetadata;
  /** Last connect/refresh error, surfaced by the OAuth manager. */
  lastError?: string;
}

/**
 * Event emitted by an adapter (e.g. "new_email" from GmailAdapter). Delivered
 * to the notifications module which writes it to the Inbox and bumps the
 * badge counter.
 */
export interface IntegrationEvent {
  type: string;
  /** `<integrationId>/<serviceId>`, e.g. "gsuite/gmail". */
  service: string;
  /** Epoch millis. */
  timestamp: number;
  /** Free-form payload — the notification file preserves this verbatim. */
  data: Record<string, unknown>;
}

/**
 * A pending OAuth flow held in-memory while the user is at the provider's
 * consent screen. Consumed once by the callback handler.
 */
export interface PendingOAuthFlow {
  integrationId: string;
  /** PKCE code verifier — kept server-side, never sent to the provider. */
  verifier: string;
  /** Scopes requested at flow start. */
  scopes: string[];
  /** Epoch millis when this flow was created. Used for TTL pruning. */
  createdAt: number;
}
