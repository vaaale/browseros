"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PlugZap, Plug, Save, Check, KeyRound, Trash2, RefreshCw } from "lucide-react";

// Mirrors src/lib/devharness/provider.ts's server-only types (that module can't
// be imported from a client component).
type HarnessSelection = "claude" | "opencode";
type ClaudeRunMode = "cli" | "stdio" | "http" | "sse";
type ClaudeAuthMethod = "credential-file" | "api-key" | "oauth-token" | "bedrock" | "vertex";
// OpenCode's auth method IS the provider choice (a dropdown of real ids — a
// free-text id was verified unsafe, see provider.ts); only some need fields
// beyond the generic apiKey/baseUrl pair.
const OPENCODE_GENERIC_PROVIDERS = [
  "anthropic", "openai", "openrouter", "groq", "deepseek", "together-ai", "fireworks-ai", "xai", "ollama",
] as const;
type OpenCodeAuthMethod =
  | "credential-file"
  | (typeof OPENCODE_GENERIC_PROVIDERS)[number]
  | "amazon-bedrock"
  | "google-vertex"
  | "azure"
  | "custom";

interface Values {
  // Top-level choice (029-settings-dev-harness US4): which coding agent runs
  // development tasks. Below, one row per CLI is always rendered; only the
  // row matching `harness` is enabled.
  harness: HarnessSelection;
  // Claude Code row.
  claudeRunMode: ClaudeRunMode;
  command: string;
  url: string;
  claudeAuthMethod: ClaudeAuthMethod;
  claudeApiKey: string;
  claudeOAuthToken: string;
  claudeApiBaseUrl: string;
  claudeBedrockRegion: string;
  claudeBedrockProfile: string;
  claudeVertexProject: string;
  claudeVertexRegion: string;
  claudeModel: string;
  // OpenCode row.
  opencodeAuthMethod: OpenCodeAuthMethod;
  opencodeApiKey: string;
  opencodeBaseUrl: string;
  opencodeBedrockRegion: string;
  opencodeBedrockProfile: string;
  opencodeBedrockEndpoint: string;
  opencodeVertexProject: string;
  opencodeVertexLocation: string;
  opencodeAzureResourceName: string;
  opencodeCustomProviderId: string;
  opencodeCustomNpmPackage: string;
  opencodeCustomModelId: string;
  opencodeModel: string;
  opencodeContextSize: number | undefined;
  cliTimeoutSec: number;
}
interface TestResult {
  ok: boolean;
  mode?: string;
  tool?: string;
  version?: string;
  tools?: string[];
  error?: string;
}

const fieldCls = "rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30 disabled:opacity-50";
const rowLabelCls = "grid grid-cols-[120px_1fr] items-center gap-2";

// A write-only credential field: paste content to set it, or clear an existing
// one. The stored content is never returned to the client — only a set/unset flag.
function CredentialField({
  label,
  hint,
  isSet,
  onSave,
  onClear,
  disabled,
}: {
  label: string;
  hint: React.ReactNode;
  isSet: boolean;
  onSave: (content: string) => Promise<void>;
  onClear: () => Promise<void>;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const doSave = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try { await onSave(value.trim()); setValue(""); setDone(true); setTimeout(() => setDone(false), 3000); }
    finally { setBusy(false); }
  };
  const doClear = async () => {
    setBusy(true);
    try { await onClear(); setValue(""); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-white/60">{label}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${isSet ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-white/40"}`}>
          {isSet ? "SET" : "NOT SET"}
        </span>
      </div>
      <p className="text-white/40">{hint}</p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        disabled={disabled}
        placeholder={isSet ? "Paste new content to replace the stored credential…" : "Paste credential content…"}
        className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-white/30 disabled:opacity-50"
      />
      <div className="flex items-center gap-2">
        <button onClick={doSave} disabled={disabled || busy || !value.trim()} className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1 hover:bg-white/20 disabled:opacity-40">
          {busy ? <Loader2 size={12} className="animate-spin" /> : done ? <Check size={12} className="text-emerald-300" /> : <KeyRound size={12} />}
          {done ? "Saved" : "Save credential"}
        </button>
        {isSet && (
          <button onClick={doClear} disabled={disabled || busy} className="flex items-center gap-1.5 rounded bg-red-500/15 px-2.5 py-1 text-red-200 hover:bg-red-500/25 disabled:opacity-40">
            <Trash2 size={12} /> Clear
          </button>
        )}
      </div>
    </div>
  );
}

// A masked secret input for simple string secrets stored via the generic
// config namespace (distinct from CredentialField's write-only OAuth-material
// textarea): shows a "saved — type to replace" placeholder when set, and an
// empty submitted value leaves the stored value unchanged (server-side coerce()).
function SecretInput({
  value,
  onChange,
  isSet,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  isSet: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="password"
      autoComplete="new-password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={isSet ? "•••••••• (saved — type to replace)" : placeholder}
      className={`w-full ${fieldCls}`}
    />
  );
}

// A per-CLI settings panel: always rendered so the full configuration shape is
// visible, but dimmed/non-interactive when it isn't the active harness — its
// own saved settings are untouched, just not currently in effect.
function HarnessPanel({ title, enabled, children }: { title: string; enabled: boolean; children: React.ReactNode }) {
  return (
    <div className={`space-y-3 rounded border p-3 transition-opacity ${enabled ? "border-white/10 bg-white/[0.03]" : "border-white/5 bg-white/[0.015] opacity-60"}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-white/80">{title}</span>
        {!enabled && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40">not active</span>}
      </div>
      {children}
    </div>
  );
}

export function DevHarnessTab() {
  const [v, setV] = useState<Values | null>(null);
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [creds, setCreds] = useState<{ claudeSet: boolean; openCodeSet: boolean; vertexServiceAccountSet: boolean }>({
    claudeSet: false,
    openCodeSet: false,
    vertexServiceAccountSet: false,
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const loadCreds = () =>
    fetch("/api/dev-harness/credentials")
      .then((r) => r.json())
      .then((d) => setCreds({ claudeSet: !!d.claudeSet, openCodeSet: !!d.openCodeSet, vertexServiceAccountSet: !!d.vertexServiceAccountSet }))
      .catch(() => {});

  // Which CLI's models are currently relevant — null when Claude's run mode is
  // an MCP mode (auth/model don't apply to an already-running remote harness).
  const activeModelTarget: "cli" | "opencode" | null = !v
    ? null
    : v.harness === "opencode"
      ? "opencode"
      : v.claudeRunMode === "cli"
        ? "cli"
        : null;

  // Claude Code has no API to list models without an Anthropic key (which the
  // harness doesn't require — it authenticates via its own credential file),
  // so "cli" serves a maintained static list. "opencode" runs `opencode
  // models`, which prints every model its configured providers expose.
  const fetchModels = useCallback(async (target: "cli" | "opencode" | null) => {
    if (!target) {
      setAvailableModels([]);
      setModelsError(null);
      return;
    }
    const seq = ++fetchSeq.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetch(`/api/dev-harness/models?transport=${target}`);
      const data = (await res.json()) as { models?: string[]; error?: string };
      if (seq !== fetchSeq.current) return; // stale response
      setAvailableModels(data.models ?? []);
      setModelsError(data.error ?? null);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      setAvailableModels([]);
      setModelsError((err as Error).message);
    } finally {
      if (seq === fetchSeq.current) setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!v) return;
    const handle = setTimeout(() => {
      void fetchModels(activeModelTarget);
    }, 0);
    return () => clearTimeout(handle);
  }, [activeModelTarget, fetchModels, v]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        const s = (d.schemas ?? []).find((x: { namespace: string }) => x.namespace === "dev-harness");
        const vals = (s?.values ?? {}) as Partial<Values>;
        setV({
          harness: (vals.harness as HarnessSelection) || "claude",
          claudeRunMode: (vals.claudeRunMode as ClaudeRunMode) || "cli",
          command: vals.command || "claude mcp serve",
          url: vals.url || "",
          claudeAuthMethod: (vals.claudeAuthMethod as ClaudeAuthMethod) || "credential-file",
          claudeApiKey: vals.claudeApiKey || "",
          claudeOAuthToken: vals.claudeOAuthToken || "",
          claudeApiBaseUrl: vals.claudeApiBaseUrl || "",
          claudeBedrockRegion: vals.claudeBedrockRegion || "",
          claudeBedrockProfile: vals.claudeBedrockProfile || "",
          claudeVertexProject: vals.claudeVertexProject || "",
          claudeVertexRegion: vals.claudeVertexRegion || "",
          claudeModel: vals.claudeModel || "",
          opencodeAuthMethod: (vals.opencodeAuthMethod as OpenCodeAuthMethod) || "credential-file",
          opencodeApiKey: vals.opencodeApiKey || "",
          opencodeBaseUrl: vals.opencodeBaseUrl || "",
          opencodeBedrockRegion: vals.opencodeBedrockRegion || "",
          opencodeBedrockProfile: vals.opencodeBedrockProfile || "",
          opencodeBedrockEndpoint: vals.opencodeBedrockEndpoint || "",
          opencodeVertexProject: vals.opencodeVertexProject || "",
          opencodeVertexLocation: vals.opencodeVertexLocation || "",
          opencodeAzureResourceName: vals.opencodeAzureResourceName || "",
          opencodeCustomProviderId: vals.opencodeCustomProviderId || "",
          opencodeCustomNpmPackage: vals.opencodeCustomNpmPackage || "",
          opencodeCustomModelId: vals.opencodeCustomModelId || "",
          opencodeModel: vals.opencodeModel || "",
          opencodeContextSize: typeof vals.opencodeContextSize === "number" ? vals.opencodeContextSize : undefined,
          cliTimeoutSec: typeof vals.cliTimeoutSec === "number" ? vals.cliTimeoutSec : 1000,
        });
        setSecretsSet((s?.secretsSet ?? {}) as Record<string, boolean>);
      })
      .catch(() => {});
    void loadCreds();
  }, []);

  const saveClaude = async (content: string) => {
    await fetch("/api/dev-harness/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claude: content }) });
    await loadCreds();
  };
  const clearClaude = async () => {
    await fetch("/api/dev-harness/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clearClaude: true }) });
    await loadCreds();
  };
  const saveOpenCode = async (content: string) => {
    await fetch("/api/dev-harness/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ openCode: content }) });
    await loadCreds();
  };
  const clearOpenCode = async () => {
    await fetch("/api/dev-harness/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clearOpenCode: true }) });
    await loadCreds();
  };
  const saveVertexServiceAccount = async (content: string) => {
    await fetch("/api/dev-harness/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vertexServiceAccount: content }) });
    await loadCreds();
  };
  const clearVertexServiceAccount = async () => {
    await fetch("/api/dev-harness/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clearVertexServiceAccount: true }) });
    await loadCreds();
  };

  if (!v) return <p className="text-xs text-white/40">Loading…</p>;

  const set = (patch: Partial<Values>) => {
    setV({ ...v, ...patch });
    setSaved(false);
  };

  const persist = async () => {
    await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "dev-harness", values: v }),
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await persist();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await persist(); // probe uses the stored config, so save current edits first
      setTest(await fetch("/api/dev-harness").then((r) => r.json()));
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const claudeEnabled = v.harness === "claude";
  const opencodeEnabled = v.harness === "opencode";

  const modelsHint = (target: "cli" | "opencode") =>
    activeModelTarget !== target ? null : modelsLoading ? (
      "Loading models…"
    ) : modelsError ? (
      <span className="text-amber-300/80">Couldn&apos;t fetch models: {modelsError}</span>
    ) : availableModels.length > 0 ? (
      `${availableModels.length} model${availableModels.length === 1 ? "" : "s"} available — start typing to filter, or enter a custom name.`
    ) : (
      "No models discovered — you can still type a custom model name."
    );

  return (
    <div className="max-w-xl space-y-4 text-xs">
      <p className="text-white/50">
        Which coding agent runs <b>development</b> tasks (building apps, modifying BOS) and how it authenticates.
        Both rows below keep their own settings independently — switching the harness never discards the other one&apos;s.
      </p>

      <label className={rowLabelCls}>
        <span className="text-white/60">Dev Harness</span>
        <select value={v.harness} onChange={(e) => set({ harness: e.target.value as HarnessSelection })} className={fieldCls}>
          <option value="claude">Claude Code</option>
          <option value="opencode">OpenCode</option>
        </select>
      </label>

      {/* Claude Code row */}
      <HarnessPanel title="Claude Code" enabled={claudeEnabled}>
        <label className={rowLabelCls}>
          <span className="text-white/60">Run mode</span>
          <select
            value={v.claudeRunMode}
            disabled={!claudeEnabled}
            onChange={(e) => set({ claudeRunMode: e.target.value as ClaudeRunMode })}
            className={fieldCls}
          >
            <option value="cli">Local CLI (headless, recommended)</option>
            <option value="stdio">MCP stdio (claude mcp serve)</option>
            <option value="http">MCP HTTP (remote)</option>
            <option value="sse">MCP SSE (remote)</option>
          </select>
        </label>

        {v.claudeRunMode === "stdio" && (
          <label className={rowLabelCls}>
            <span className="text-white/60">stdio command</span>
            <input
              value={v.command}
              disabled={!claudeEnabled}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="claude mcp serve"
              className={fieldCls}
            />
          </label>
        )}

        {(v.claudeRunMode === "http" || v.claudeRunMode === "sse") && (
          <label className={rowLabelCls}>
            <span className="text-white/60">Harness URL</span>
            <input
              value={v.url}
              disabled={!claudeEnabled}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="http://host:7272/mcp"
              className={fieldCls}
            />
          </label>
        )}

        {v.claudeRunMode === "cli" && (
          <>
            <label className={rowLabelCls}>
              <span className="text-white/60">Auth method</span>
              <select
                value={v.claudeAuthMethod}
                disabled={!claudeEnabled}
                onChange={(e) => set({ claudeAuthMethod: e.target.value as ClaudeAuthMethod })}
                className={fieldCls}
              >
                <option value="credential-file">Credential file (paste below)</option>
                <option value="api-key">API key</option>
                <option value="oauth-token">OAuth token (claude setup-token)</option>
                <option value="bedrock">AWS Bedrock</option>
                <option value="vertex">Google Vertex AI</option>
              </select>
            </label>

            {v.claudeAuthMethod === "credential-file" && (
              <CredentialField
                label="Claude Code credential file"
                hint={
                  <>
                    Contents of <code>~/.claude/.credentials.json</code> from a machine where you&apos;ve run <code>claude</code> and
                    logged in. In a container there is no interactive login, so paste it here; BOS writes it into a dedicated harness{" "}
                    <code>HOME</code> (owner-only, never logged).
                  </>
                }
                isSet={creds.claudeSet}
                onSave={saveClaude}
                onClear={clearClaude}
                disabled={!claudeEnabled}
              />
            )}

            {v.claudeAuthMethod === "api-key" && (
              <>
                <label className={rowLabelCls}>
                  <span className="text-white/60">API key</span>
                  <SecretInput value={v.claudeApiKey} onChange={(val) => set({ claudeApiKey: val })} isSet={!!secretsSet.claudeApiKey} disabled={!claudeEnabled} />
                </label>
                <label className={rowLabelCls}>
                  <span className="text-white/60">Base URL</span>
                  <input
                    value={v.claudeApiBaseUrl}
                    disabled={!claudeEnabled}
                    onChange={(e) => set({ claudeApiBaseUrl: e.target.value })}
                    placeholder="https://api.anthropic.com (blank = default)"
                    className={fieldCls}
                  />
                </label>
              </>
            )}

            {v.claudeAuthMethod === "oauth-token" && (
              <>
                <p className="text-xs text-white/50">
                  Run <code>claude setup-token</code> (requires a Claude subscription) on any machine with a browser — it walks
                  you through OAuth once and prints a long-lived token. Unlike the credential file above, this is its own
                  separate OAuth grant, not a copy of an interactive session&apos;s rotating refresh token — so it keeps working
                  here even while you keep using <code>claude</code> normally on your own machine, and vice versa.
                </p>
                <label className={rowLabelCls}>
                  <span className="text-white/60">OAuth token</span>
                  <SecretInput
                    value={v.claudeOAuthToken}
                    onChange={(val) => set({ claudeOAuthToken: val })}
                    isSet={!!secretsSet.claudeOAuthToken}
                    disabled={!claudeEnabled}
                  />
                </label>
              </>
            )}

            {v.claudeAuthMethod === "bedrock" && (
              <>
                <label className={rowLabelCls}>
                  <span className="text-white/60">AWS region</span>
                  <input value={v.claudeBedrockRegion} disabled={!claudeEnabled} onChange={(e) => set({ claudeBedrockRegion: e.target.value })} placeholder="us-east-1" className={fieldCls} />
                </label>
                <label className={rowLabelCls}>
                  <span className="text-white/60">AWS profile</span>
                  <input value={v.claudeBedrockProfile} disabled={!claudeEnabled} onChange={(e) => set({ claudeBedrockProfile: e.target.value })} placeholder="(blank = default profile)" className={fieldCls} />
                </label>
              </>
            )}

            {v.claudeAuthMethod === "vertex" && (
              <>
                <label className={rowLabelCls}>
                  <span className="text-white/60">GCP project</span>
                  <input value={v.claudeVertexProject} disabled={!claudeEnabled} onChange={(e) => set({ claudeVertexProject: e.target.value })} className={fieldCls} />
                </label>
                <label className={rowLabelCls}>
                  <span className="text-white/60">GCP region</span>
                  <input value={v.claudeVertexRegion} disabled={!claudeEnabled} onChange={(e) => set({ claudeVertexRegion: e.target.value })} placeholder="us-central1" className={fieldCls} />
                </label>
              </>
            )}

            <label className={rowLabelCls}>
              <span className="text-white/60">Model</span>
              <div className="flex items-center gap-1.5">
                <input
                  list="claude-models"
                  value={v.claudeModel}
                  disabled={!claudeEnabled}
                  onChange={(e) => set({ claudeModel: e.target.value })}
                  placeholder="e.g. claude-opus-4-7 (blank = CLI default)"
                  className={`flex-1 ${fieldCls}`}
                />
                <datalist id="claude-models">{activeModelTarget === "cli" && availableModels.map((m) => <option key={m} value={m} />)}</datalist>
                <button
                  type="button"
                  onClick={() => void fetchModels("cli")}
                  disabled={!claudeEnabled || modelsLoading}
                  title="Refresh model list"
                  className="flex items-center gap-1 rounded border border-white/10 bg-black/20 px-2 py-1.5 hover:bg-white/10 disabled:opacity-40"
                >
                  {modelsLoading && activeModelTarget === "cli" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                </button>
              </div>
            </label>
            {modelsHint("cli") && <p className="text-[11px] text-white/40">{modelsHint("cli")}</p>}
            <p className="rounded border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-amber-100/80">
              Claude runs with <code>--dangerously-skip-permissions</code> (no edit/command prompts). Intended to be sandboxed (e.g.
              Docker). BOS source edits require Supervisor isolation and run only in a feature-branch worktree.
            </p>
          </>
        )}
      </HarnessPanel>

      {/* OpenCode row */}
      <HarnessPanel title="OpenCode" enabled={opencodeEnabled}>
        <label className={rowLabelCls}>
          <span className="text-white/60">Auth method</span>
          <select
            value={v.opencodeAuthMethod}
            disabled={!opencodeEnabled}
            onChange={(e) => set({ opencodeAuthMethod: e.target.value as OpenCodeAuthMethod })}
            className={fieldCls}
          >
            <option value="credential-file">Credential file (paste below)</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="groq">Groq</option>
            <option value="deepseek">DeepSeek</option>
            <option value="together-ai">Together AI</option>
            <option value="fireworks-ai">Fireworks AI</option>
            <option value="xai">xAI</option>
            <option value="ollama">Ollama (local)</option>
            <option value="amazon-bedrock">AWS Bedrock</option>
            <option value="google-vertex">Google Vertex AI</option>
            <option value="azure">Azure OpenAI</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        {v.opencodeAuthMethod === "credential-file" && (
          <CredentialField
            label="OpenCode credential file"
            hint={
              <>
                Contents of <code>~/.local/share/opencode/auth.json</code> from a machine where you&apos;ve run{" "}
                <code>opencode auth login</code>. In a container there is no interactive login, so paste it here; BOS writes it into a
                dedicated harness <code>HOME</code> (owner-only, never logged).
              </>
            }
            isSet={creds.openCodeSet}
            onSave={saveOpenCode}
            onClear={clearOpenCode}
            disabled={!opencodeEnabled}
          />
        )}

        {(OPENCODE_GENERIC_PROVIDERS as readonly string[]).includes(v.opencodeAuthMethod) && (
          <>
            <label className={rowLabelCls}>
              <span className="text-white/60">API key</span>
              <SecretInput value={v.opencodeApiKey} onChange={(val) => set({ opencodeApiKey: val })} isSet={!!secretsSet.opencodeApiKey} disabled={!opencodeEnabled} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">Base URL</span>
              <input
                value={v.opencodeBaseUrl}
                disabled={!opencodeEnabled}
                onChange={(e) => set({ opencodeBaseUrl: e.target.value })}
                placeholder="(blank = provider default)"
                className={fieldCls}
              />
            </label>
          </>
        )}

        {v.opencodeAuthMethod === "amazon-bedrock" && (
          <>
            <label className={rowLabelCls}>
              <span className="text-white/60">AWS region</span>
              <input value={v.opencodeBedrockRegion} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeBedrockRegion: e.target.value })} placeholder="us-east-1" className={fieldCls} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">AWS profile</span>
              <input value={v.opencodeBedrockProfile} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeBedrockProfile: e.target.value })} placeholder="(blank = default profile)" className={fieldCls} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">VPC endpoint</span>
              <input value={v.opencodeBedrockEndpoint} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeBedrockEndpoint: e.target.value })} placeholder="(optional)" className={fieldCls} />
            </label>
          </>
        )}

        {v.opencodeAuthMethod === "google-vertex" && (
          <>
            <CredentialField
              label="Vertex service-account JSON"
              hint={<>Contents of a GCP service-account key JSON file. BOS writes it into the harness <code>HOME</code> and points <code>GOOGLE_APPLICATION_CREDENTIALS</code> at it when spawning — this and the fields below are environment variables, not part of a config file.</>}
              isSet={creds.vertexServiceAccountSet}
              onSave={saveVertexServiceAccount}
              onClear={clearVertexServiceAccount}
              disabled={!opencodeEnabled}
            />
            <label className={rowLabelCls}>
              <span className="text-white/60">GCP project</span>
              <input value={v.opencodeVertexProject} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeVertexProject: e.target.value })} className={fieldCls} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">GCP location</span>
              <input value={v.opencodeVertexLocation} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeVertexLocation: e.target.value })} placeholder="global" className={fieldCls} />
            </label>
          </>
        )}

        {v.opencodeAuthMethod === "azure" && (
          <>
            <label className={rowLabelCls}>
              <span className="text-white/60">Resource name</span>
              <input value={v.opencodeAzureResourceName} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeAzureResourceName: e.target.value })} className={fieldCls} />
            </label>
            <p className="text-[11px] text-white/40">Set as the environment variable AZURE_RESOURCE_NAME at spawn time (no config-file option exists for it).</p>
            <label className={rowLabelCls}>
              <span className="text-white/60">API key</span>
              <SecretInput value={v.opencodeApiKey} onChange={(val) => set({ opencodeApiKey: val })} isSet={!!secretsSet.opencodeApiKey} disabled={!opencodeEnabled} />
            </label>
          </>
        )}

        {v.opencodeAuthMethod === "custom" && (
          <>
            <label className={rowLabelCls}>
              <span className="text-white/60">Provider id</span>
              <input value={v.opencodeCustomProviderId} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeCustomProviderId: e.target.value })} placeholder="e.g. myserver" className={fieldCls} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">npm package</span>
              <input value={v.opencodeCustomNpmPackage} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeCustomNpmPackage: e.target.value })} placeholder="@ai-sdk/openai-compatible" className={fieldCls} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">Model id</span>
              <input value={v.opencodeCustomModelId} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeCustomModelId: e.target.value })} className={fieldCls} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">API key</span>
              <SecretInput value={v.opencodeApiKey} onChange={(val) => set({ opencodeApiKey: val })} isSet={!!secretsSet.opencodeApiKey} disabled={!opencodeEnabled} />
            </label>
            <label className={rowLabelCls}>
              <span className="text-white/60">Base URL</span>
              <input value={v.opencodeBaseUrl} disabled={!opencodeEnabled} onChange={(e) => set({ opencodeBaseUrl: e.target.value })} className={fieldCls} />
            </label>
          </>
        )}

        <label className={rowLabelCls}>
          <span className="text-white/60">Model</span>
          <div className="flex items-center gap-1.5">
            <input
              list="opencode-models"
              value={v.opencodeModel}
              disabled={!opencodeEnabled}
              onChange={(e) => set({ opencodeModel: e.target.value })}
              placeholder="e.g. claude-opus-4-7 (blank = CLI default)"
              className={`flex-1 ${fieldCls}`}
            />
            <datalist id="opencode-models">{activeModelTarget === "opencode" && availableModels.map((m) => <option key={m} value={m} />)}</datalist>
            <button
              type="button"
              onClick={() => void fetchModels("opencode")}
              disabled={!opencodeEnabled || modelsLoading}
              title="Refresh model list"
              className="flex items-center gap-1 rounded border border-white/10 bg-black/20 px-2 py-1.5 hover:bg-white/10 disabled:opacity-40"
            >
              {modelsLoading && activeModelTarget === "opencode" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </button>
          </div>
        </label>
        {modelsHint("opencode") && <p className="text-[11px] text-white/40">{modelsHint("opencode")}</p>}
        <label className={rowLabelCls}>
          <span className="text-white/60">Context window</span>
          <input
            type="number"
            min={1}
            value={v.opencodeContextSize ?? ""}
            disabled={!opencodeEnabled}
            onChange={(e) => set({ opencodeContextSize: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="blank = OpenCode's own default"
            className={fieldCls}
          />
        </label>
        <p className="text-white/40">
          Context window (tokens) of the model above, written into opencode.json so OpenCode stops before overflowing it.
        </p>
        <p className="rounded border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-amber-100/80">
          OpenCode runs with <code>--auto</code> (no edit/command prompts). Intended to be sandboxed (e.g. Docker). BOS source edits
          require Supervisor isolation and run only in a feature-branch worktree.
        </p>
      </HarnessPanel>

      <label className={rowLabelCls}>
        <span className="text-white/60">CLI run timeout (sec)</span>
        <input
          type="number"
          min={60}
          value={v.cliTimeoutSec}
          onChange={(e) => set({ cliTimeoutSec: Number(e.target.value) })}
          className={fieldCls}
        />
      </label>
      <p className="text-white/40">
        Max time a headless Claude/OpenCode CLI run may take before it&apos;s killed and reported as a timeout (Local run
        mode only — minimum 60s, default 1000, no upper bound).
      </p>

      <p className="text-white/40">
        Want the active CLI to have an MCP server too? Check <b>&quot;Include in Dev Harness&quot;</b> on it under{" "}
        <b>Settings → MCP Servers</b> — it&apos;s folded in automatically the next time this config is saved.
      </p>

      <div className="flex items-center gap-2 pt-1">
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 rounded bg-white/10 px-3 py-1.5 hover:bg-white/20 disabled:opacity-40">
          {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} className="text-emerald-300" /> : <Save size={13} />}
          {saved ? "Saved" : "Save"}
        </button>
        <button onClick={runTest} disabled={testing} className="flex items-center gap-1.5 rounded bg-violet-500/20 px-3 py-1.5 text-violet-100 hover:bg-violet-500/30 disabled:opacity-40">
          {testing ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
          Test
        </button>
      </div>

      {test && (
        <div
          className={`flex items-start gap-2 rounded border px-3 py-2 ${
            test.ok ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : "border-amber-400/30 bg-amber-400/10 text-amber-100"
          }`}
        >
          {test.ok ? <PlugZap size={14} className="mt-0.5 shrink-0" /> : <Plug size={14} className="mt-0.5 shrink-0" />}
          <span>
            {test.ok
              ? test.mode === "cli"
                ? `${test.tool === "opencode" ? "OpenCode" : "Claude"} CLI ready — ${test.version ?? "installed"}.`
                : `Connected — ${test.tools?.length ?? 0} tools${test.tools?.includes("Agent") ? " (Agent available)" : ""}.`
              : `Not available: ${test.error}`}
          </span>
        </div>
      )}
    </div>
  );
}
