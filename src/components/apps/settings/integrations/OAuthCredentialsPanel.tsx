"use client";

import { useCallback, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Pencil, X } from "lucide-react";
import { getRedirectUri, resolveClientPublicOrigin } from "@/lib/integrations/oauth/origin";

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  /** Base URL of a self-hosted GitLab instance, e.g. https://gitlab.example.com. */
  instanceUrl?: string;
}

/** True when `value` parses as an http(s) URL. */
function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface OAuthCredentialsPanelProps {
  /** Provider / integration id the credentials belong to (e.g. "github"). */
  integrationId: string;
  /** Human-readable name for copy, e.g. "GitHub". */
  providerName: string;
  /** Whether credentials are already stored. Drives the initial view. */
  hasCredentials: boolean;
  /** Called after a successful save so the parent can refresh its status. */
  onSaved: () => void | Promise<void>;
  /**
   * Optional override for the persistence call. When omitted the panel POSTs
   * to `/api/integrations/<id>/credentials` itself, so it works standalone.
   */
  onSubmit?: (integrationId: string, credentials: OAuthCredentials) => Promise<void>;
  /**
   * Callback path this provider's OAuth flow redirects back to (e.g.
   * "/api/git-remotes/oauth/callback"). When supplied the panel shows the
   * exact, copyable redirect URI the user must register with the provider,
   * resolved against the public origin. Omit to hide the section.
   */
  redirectUriPath?: string;
}

/**
 * Field-based Client ID / Client Secret editor for OAuth providers that don't
 * ship a downloadable `client_secrets.json` (GitHub, GitLab, …). Mirrors the
 * dark settings-form styling used across the Integrations tab.
 *
 * When credentials already exist it renders a compact "Configured" status with
 * an Edit affordance; editing (or the not-configured case) reveals the form.
 */
export function OAuthCredentialsPanel({
  integrationId,
  providerName,
  hasCredentials,
  onSaved,
  onSubmit,
  redirectUriPath,
}: OAuthCredentialsPanelProps) {
  const isGitLab = integrationId === "gitlab";

  const [editing, setEditing] = useState(!hasCredentials);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  // Resolved once on the client (the window.location fallback needs the
  // browser); the panel only mounts after user interaction, so there is no SSR
  // paint to mismatch against.
  const [redirectUri] = useState(() =>
    redirectUriPath ? getRedirectUri(redirectUriPath) : "",
  );
  // The public origin as seen by the browser (the address bar). When
  // NEXT_PUBLIC_APP_ORIGIN is not inlined this is window.location.origin — i.e.
  // the real public URL, which the server CANNOT infer behind a reverse proxy
  // that rewrites Host. We surface it so the user knows exactly what to pin.
  const [detectedOrigin] = useState(() => resolveClientPublicOrigin());
  const [copied, setCopied] = useState(false);

  const copyRedirectUri = useCallback(async () => {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied (e.g. insecure context); ignore.
    }
  }, [redirectUri]);

  const hasPublicOrigin = Boolean(process.env.NEXT_PUBLIC_APP_ORIGIN);

  const reset = useCallback(() => {
    setClientId("");
    setClientSecret("");
    setInstanceUrl("");
    setError(undefined);
  }, []);

  const save = useCallback(async () => {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    const trimmedUrl = instanceUrl.trim();
    if (!trimmedId || !trimmedSecret) {
      setError("Both Client ID and Client Secret are required.");
      return;
    }
    if (isGitLab && trimmedUrl && !looksLikeUrl(trimmedUrl)) {
      setError("GitLab instance URL must be a valid http(s) URL.");
      return;
    }
    const credentials: OAuthCredentials = {
      clientId: trimmedId,
      clientSecret: trimmedSecret,
      ...(isGitLab && trimmedUrl ? { instanceUrl: trimmedUrl } : {}),
    };
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      if (onSubmit) {
        await onSubmit(integrationId, credentials);
      } else {
        const res = await fetch(`/api/integrations/${encodeURIComponent(integrationId)}/credentials`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentials),
        });
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(payload.error ?? `Save failed: ${res.status}`);
      }
      reset();
      setSaved(true);
      setEditing(false);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [clientId, clientSecret, instanceUrl, isGitLab, integrationId, onSubmit, onSaved, reset]);

  // Shown in both the configured and editing views: the exact redirect URI the
  // user must register with the provider (rendered only when the caller passes
  // the flow's callback path).
  const redirectSection = redirectUriPath ? (
    <div className="mt-4 space-y-2">
      <div className="text-[11px] font-medium text-white/60">Redirect URI</div>
      <p className="text-[10.5px] text-white/40">
        Add this exact URL to your {providerName} OAuth app’s callback / redirect URI list:
      </p>
      <div className="flex items-center gap-2 rounded border border-white/15 bg-white/[0.05] p-2.5">
        <code className="min-w-0 flex-1 truncate text-[11px] text-white/80">
          {redirectUri || "…"}
        </code>
        <button
          type="button"
          onClick={() => void copyRedirectUri()}
          disabled={!redirectUri}
          title="Copy redirect URI"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-white/15 px-2 py-1 text-[10.5px] font-medium text-white/70 transition-colors hover:bg-white/10 disabled:opacity-50"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {!hasPublicOrigin && (
        <div className="rounded border border-amber-400/30 bg-amber-500/10 p-2.5">
          <p className="text-[10.5px] leading-relaxed text-white/60">
            <strong className="font-semibold text-white/80">Note:</strong>{" "}
            <code className="text-white/80">NEXT_PUBLIC_APP_ORIGIN</code> is not set at build time.
            Behind a reverse proxy the server can’t reliably infer the public URL, so set{" "}
            <code className="text-white/80">NEXT_PUBLIC_APP_ORIGIN</code>{" "}
            {detectedOrigin ? (
              <>
                to <code className="text-white/80">{detectedOrigin}</code>
              </>
            ) : (
              <>to your public URL (e.g. <code className="text-white/80">https://bos.schmopilot.com</code>)</>
            )}{" "}
            so the redirect URI above is generated correctly by the OAuth flow.
          </p>
        </div>
      )}
    </div>
  ) : null;

  // Compact "already configured" view with an Edit button.
  if (!editing) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.05] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-[13px] font-medium">Credentials configured</span>
          </div>
          <button
            type="button"
            onClick={() => {
              reset();
              setSaved(false);
              setEditing(true);
            }}
            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1.5 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10"
          >
            <Pencil size={12} /> Edit
          </button>
        </div>
        {saved && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-300">
            <Check size={12} /> Saved.
          </div>
        )}
        {redirectSection}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/15 bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center gap-2">
        <KeyRound size={16} className="text-white/50" />
        <div className="text-[12px] font-medium text-white/80">
          {providerName} OAuth app credentials
        </div>
      </div>
      <p className="mb-3 text-[10.5px] text-white/40">
        Enter the Client ID and Client Secret from your {providerName} OAuth app. Encrypted at rest —
        never committed to your repo.
      </p>

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-white/60">Client ID</span>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. Iv1.a1b2c3d4e5f6g7h8"
            className="w-full rounded border border-white/15 bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-white outline-none transition-colors placeholder:text-white/25 focus:border-violet-400/60 disabled:opacity-50"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-white/60">Client Secret</span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder="••••••••••••••••"
            className="w-full rounded border border-white/15 bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-white outline-none transition-colors placeholder:text-white/25 focus:border-violet-400/60 disabled:opacity-50"
          />
        </label>
        {isGitLab && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-white/60">
              GitLab instance URL{" "}
              <span className="font-normal text-white/35">(self-hosted only)</span>
            </span>
            <input
              type="url"
              value={instanceUrl}
              onChange={(e) => setInstanceUrl(e.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://gitlab.example.com"
              className="w-full rounded border border-white/15 bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-white outline-none transition-colors placeholder:text-white/25 focus:border-violet-400/60 disabled:opacity-50"
            />
            <span className="mt-1 block text-[10.5px] text-white/35">
              Leave blank for gitlab.com.
            </span>
          </label>
        )}
      </div>

      {redirectSection}

      {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? "Saving…" : "Save"}
        </button>
        {hasCredentials && (
          <button
            type="button"
            onClick={() => {
              reset();
              setEditing(false);
            }}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1.5 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            <X size={12} /> Cancel
          </button>
        )}
      </div>
    </div>
  );
}
