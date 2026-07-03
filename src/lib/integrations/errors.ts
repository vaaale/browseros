// Framework-free error hierarchy for the integrations subsystem. Safe to
// import from client OR server code.
//
// Adapter methods throw these; the CopilotKit action wrapper turns them
// into structured tool results the LLM can reason about (see plan §D6).

export class IntegrationError extends Error {
  /** Stable machine-readable code, used by API/tool wrappers. */
  public readonly code: string;
  /** Integration id this error relates to, when known. */
  public readonly integrationId?: string;

  constructor(code: string, message: string, opts?: { integrationId?: string; cause?: unknown }) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.integrationId = opts?.integrationId;
    if (opts?.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/**
 * Thrown when an adapter method requires a scope that is either not granted
 * by OAuth or has been disabled by the user in Settings.
 */
export class IntegrationScopeError extends IntegrationError {
  public readonly scope: string;

  constructor(scope: string, message?: string, opts?: { integrationId?: string }) {
    super(
      "scope_disabled",
      message ?? `Scope not available: ${scope}`,
      opts,
    );
    this.name = "IntegrationScopeError";
    this.scope = scope;
  }
}

/**
 * Thrown when an integration is not connected, tokens have expired and
 * refresh failed, or the provider returned `invalid_grant`.
 */
export class IntegrationAuthError extends IntegrationError {
  constructor(message: string, opts?: { integrationId?: string; cause?: unknown }) {
    super("auth_failed", message, opts);
    this.name = "IntegrationAuthError";
  }
}

/**
 * Thrown when a user-supplied config or credential file is malformed
 * (e.g. `client_secrets.json` missing required fields).
 */
export class IntegrationConfigError extends IntegrationError {
  constructor(message: string, opts?: { integrationId?: string; cause?: unknown }) {
    super("config_invalid", message, opts);
    this.name = "IntegrationConfigError";
  }
}
