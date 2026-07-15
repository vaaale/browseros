"use client";

import { useEffect, useState } from "react";
import { Loader2, PlugZap, Plug, Save, Check, KeyRound, Trash2 } from "lucide-react";

type Transport = "cli" | "opencode" | "stdio" | "http" | "sse";
interface Values {
  transport: Transport;
  command: string;
  url: string;
}
interface TestResult {
  ok: boolean;
  mode?: string;
  tool?: string;
  version?: string;
  tools?: string[];
  error?: string;
}

// A write-only credential field: paste content to set it, or clear an existing
// one. The stored content is never returned to the client — only a set/unset flag.
function CredentialField({
  label,
  hint,
  isSet,
  onSave,
  onClear,
}: {
  label: string;
  hint: React.ReactNode;
  isSet: boolean;
  onSave: (content: string) => Promise<void>;
  onClear: () => Promise<void>;
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
        placeholder={isSet ? "Paste new content to replace the stored credential…" : "Paste credential content…"}
        className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-white/30"
      />
      <div className="flex items-center gap-2">
        <button onClick={doSave} disabled={busy || !value.trim()} className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1 hover:bg-white/20 disabled:opacity-40">
          {busy ? <Loader2 size={12} className="animate-spin" /> : done ? <Check size={12} className="text-emerald-300" /> : <KeyRound size={12} />}
          {done ? "Saved" : "Save credential"}
        </button>
        {isSet && (
          <button onClick={doClear} disabled={busy} className="flex items-center gap-1.5 rounded bg-red-500/15 px-2.5 py-1 text-red-200 hover:bg-red-500/25 disabled:opacity-40">
            <Trash2 size={12} /> Clear
          </button>
        )}
      </div>
    </div>
  );
}

export function DevHarnessTab() {
  const [v, setV] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [creds, setCreds] = useState<{ claudeSet: boolean; openCodeSet: boolean }>({ claudeSet: false, openCodeSet: false });

  const loadCreds = () =>
    fetch("/api/dev-harness/credentials")
      .then((r) => r.json())
      .then((d) => setCreds({ claudeSet: !!d.claudeSet, openCodeSet: !!d.openCodeSet }))
      .catch(() => {});

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        const s = (d.schemas ?? []).find((x: { namespace: string }) => x.namespace === "dev-harness");
        const vals = (s?.values ?? {}) as Partial<Values>;
        setV({
          transport: (vals.transport as Transport) || "cli",
          command: vals.command || "claude mcp serve",
          url: vals.url || "",
        });
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

  return (
    <div className="max-w-xl space-y-4 text-xs">
      <p className="text-white/50">
        How the <b>developer</b> sub-agent runs. <b>Claude CLI</b> spawns Claude Code headless (<code>claude -p</code>) inside this
        repository, so Claude itself reads and edits BrowserOS&apos;s source. <b>OpenCode CLI</b> does the same with <code>opencode run</code>
        {" "}(a provider-agnostic alternative). The MCP modes instead drive a <code>claude mcp serve</code> or remote harness.
      </p>

      <label className="grid grid-cols-[120px_1fr] items-center gap-2">
        <span className="text-white/60">Mode</span>
        <select
          value={v.transport}
          onChange={(e) => set({ transport: e.target.value as Transport })}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30"
        >
          <option value="cli">Claude CLI (headless, recommended)</option>
          <option value="opencode">OpenCode CLI (headless)</option>
          <option value="stdio">MCP stdio (claude mcp serve)</option>
          <option value="http">MCP HTTP (remote)</option>
          <option value="sse">MCP SSE (remote)</option>
        </select>
      </label>

      {v.transport === "stdio" && (
        <label className="grid grid-cols-[120px_1fr] items-center gap-2">
          <span className="text-white/60">stdio command</span>
          <input
            value={v.command}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="claude mcp serve"
            className="rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30"
          />
        </label>
      )}

      {(v.transport === "http" || v.transport === "sse") && (
        <label className="grid grid-cols-[120px_1fr] items-center gap-2">
          <span className="text-white/60">Harness URL</span>
          <input
            value={v.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="http://host:7272/mcp"
            className="rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30"
          />
        </label>
      )}

      {(v.transport === "cli" || v.transport === "opencode") && (
        <p className="rounded border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-amber-100/80">
          {v.transport === "opencode" ? "OpenCode" : "Claude"} runs with <code>{v.transport === "opencode" ? "--auto" : "--dangerously-skip-permissions"}</code> (no edit/command
          prompts). Intended to be sandboxed (e.g. Docker). BOS source edits require Supervisor isolation and run only in a feature-branch worktree.
        </p>
      )}

      {/* Always shown — credentials are stored independently of the selected mode,
          so you can provision them before switching to a CLI mode. */}
      <div className="space-y-4 rounded border border-white/10 bg-white/[0.03] p-3">
          <div>
            <div className="mb-1 font-medium text-white/70">CLI credentials</div>
            <p className="text-white/40">
              For the <b>Claude CLI</b> / <b>OpenCode CLI</b> modes. In a container there is no interactive login, so paste
              each CLI&apos;s auth material here; BOS writes it into a dedicated harness <code>HOME</code> (owner-only, never
              logged) and points the CLI at it when spawning.
            </p>
          </div>

          <CredentialField
            label="Claude Code"
            hint={<>Contents of <code>~/.claude/.credentials.json</code> from a machine where you&apos;ve run <code>claude</code> and logged in.</>}
            isSet={creds.claudeSet}
            onSave={saveClaude}
            onClear={clearClaude}
          />

          <CredentialField
            label="OpenCode"
            hint={<>Contents of <code>~/.local/share/opencode/auth.json</code> from a machine where you&apos;ve run <code>opencode auth login</code>.</>}
            isSet={creds.openCodeSet}
            onSave={saveOpenCode}
            onClear={clearOpenCode}
          />
      </div>

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
