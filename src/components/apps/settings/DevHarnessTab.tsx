"use client";

import { useEffect, useState } from "react";
import { Loader2, PlugZap, Plug, Save, Check } from "lucide-react";

type Transport = "cli" | "opencode" | "stdio" | "http" | "sse";
interface Values {
  transport: Transport;
  command: string;
  cwd: string;
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

export function DevHarnessTab() {
  const [v, setV] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        const s = (d.schemas ?? []).find((x: { namespace: string }) => x.namespace === "dev-harness");
        const vals = (s?.values ?? {}) as Partial<Values>;
        setV({
          transport: (vals.transport as Transport) || "cli",
          command: vals.command || "claude mcp serve",
          cwd: vals.cwd || "",
          url: vals.url || "",
        });
      })
      .catch(() => {});
  }, []);

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

      {(v.transport === "cli" || v.transport === "opencode" || v.transport === "stdio") && (
        <label className="grid grid-cols-[120px_1fr] items-center gap-2">
          <span className="text-white/60">Working dir</span>
          <input
            value={v.cwd}
            onChange={(e) => set({ cwd: e.target.value })}
            placeholder="(repo root)"
            className="rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30"
          />
        </label>
      )}

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
          {v.transport === "opencode" ? "OpenCode" : "Claude"} runs with <code>--dangerously-skip-permissions</code> (no edit/command
          prompts). Intended to be sandboxed (e.g. Docker). It works on a git feature branch so changes stay reversible.
        </p>
      )}

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
