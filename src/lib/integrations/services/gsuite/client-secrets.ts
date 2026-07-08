import { IntegrationConfigError } from "../../errors";
import type { NormalizedClientSecrets } from "../../oauth/manager";

// Normalise the two shapes Google's Cloud Console emits into the canonical
// `NormalizedClientSecrets` record stored under SecretsStore key
// `oauth_client:gsuite`. Prefers `web` over `installed` when both are present.

interface RawGoogleClientSecretsFields {
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
  auth_uri?: string;
  token_uri?: string;
}

interface RawGoogleClientSecrets {
  web?: RawGoogleClientSecretsFields;
  installed?: RawGoogleClientSecretsFields;
}

function pickBlock(raw: RawGoogleClientSecrets): { block: RawGoogleClientSecretsFields; kind: "web" | "installed" } {
  if (raw.web && raw.installed) return { block: raw.web, kind: "web" };
  if (raw.web) return { block: raw.web, kind: "web" };
  if (raw.installed) return { block: raw.installed, kind: "installed" };
  throw new IntegrationConfigError(
    "client_secrets.json must contain a `web` or `installed` block.",
    { integrationId: "gsuite" },
  );
}

export function normalizeClientSecrets(raw: unknown): NormalizedClientSecrets {
  if (!raw || typeof raw !== "object") {
    throw new IntegrationConfigError("client_secrets.json must be a JSON object.", { integrationId: "gsuite" });
  }
  const { block, kind } = pickBlock(raw as RawGoogleClientSecrets);
  const missing: string[] = [];
  if (!block.client_id) missing.push("client_id");
  if (!block.client_secret) missing.push("client_secret");
  if (!Array.isArray(block.redirect_uris) || block.redirect_uris.length === 0) missing.push("redirect_uris");
  if (!block.auth_uri) missing.push("auth_uri");
  if (!block.token_uri) missing.push("token_uri");
  if (missing.length > 0) {
    throw new IntegrationConfigError(
      `client_secrets.json (${kind}) missing required fields: ${missing.join(", ")}`,
      { integrationId: "gsuite" },
    );
  }
  return {
    clientId: block.client_id!,
    clientSecret: block.client_secret!,
    redirectUris: block.redirect_uris!,
    authUri: block.auth_uri!,
    tokenUri: block.token_uri!,
  };
}
