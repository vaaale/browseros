// Pure (framework-free, non-"server-only") half of the git credential helper.
//
// This holds the helper script source and the functions that build git's
// per-invocation credential config. It has no filesystem or secrets
// dependencies, so it is unit-testable in isolation and importable from both
// the server module (git-credential-helper.ts) and tests.

// Self-contained Node script implementing git's credential-helper protocol.
// Only `get` produces output; `store`/`erase` are intentional no-ops (the token
// is owned by BOS, not git's credential cache). Credentials come from the
// environment set by the BOS git runner, so they never appear in argv or on
// disk in plaintext.
export const HELPER_SOURCE = `#!/usr/bin/env node
"use strict";
// BrowserOS git credential helper — see src/lib/gitops/git-credential-helper.ts.
const op = process.argv[2];
if (op !== "get") { process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) { input += chunk; });
process.stdin.on("end", function () {
  const username = process.env.BOS_GIT_CRED_USERNAME || "oauth2";
  const password = process.env.BOS_GIT_CRED_PASSWORD || "";
  if (!password) { process.exit(0); }
  process.stdout.write("username=" + username + "\\npassword=" + password + "\\n");
});
`;

export const CRED_ENV_USERNAME = "BOS_GIT_CRED_USERNAME";
export const CRED_ENV_PASSWORD = "BOS_GIT_CRED_PASSWORD";

/**
 * Build the `-c` arguments that clear any inherited credential.helper and
 * register ours. A leading `!` makes git run the value as a shell command, so
 * absolute paths (which may contain spaces) are quoted.
 */
export function buildCredentialArgs(nodePath: string, scriptPath: string): string[] {
  const helperCmd = `!"${nodePath}" "${scriptPath}"`;
  return ["-c", "credential.helper=", "-c", `credential.helper=${helperCmd}`];
}

/**
 * The environment carrying the credentials to the helper. The token is passed
 * as the password with username `oauth2`, matching the
 * `https://oauth2:<token>@host` form used elsewhere; GitHub and GitLab both
 * accept a token as the password with any non-empty username, so this works for
 * OAuth access tokens and personal access tokens alike.
 */
export function buildCredentialEnv(token: string, username = "oauth2"): Record<string, string> {
  return {
    [CRED_ENV_USERNAME]: username,
    [CRED_ENV_PASSWORD]: token,
  };
}
