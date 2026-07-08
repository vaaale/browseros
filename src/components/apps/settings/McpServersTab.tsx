"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plug, PlugZap, Plus, Trash2, Play, X } from "lucide-react";
import type { McpProbeResult, McpServerConfig } from "@/lib/mcp/types";

type Transport = "http" | "sse" | "stdio";
interface KV {
  key: string;
  value: string;
}

const TRANSPORTS: { value: Transport; label: string }[] = [
  { value: "http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "stdio (local process)" },
];

const emptyRow: KV = { key: "", value: "" };

function recordToRows(rec?: Record<string, string>): KV[] {
  const rows = Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));
  return [...rows, { ...emptyRow }];
}
function rowsToRecord(rows: KV[]): Record<string, string> | undefined {
  const rec: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) rec[r.key.trim()] = r.value;
  return Object.keys(rec).length ? rec : undefined;
}

function transportOf(s: McpServerConfig): Transport {
  return s.transport === "sse" ? "sse" : s.transport === "stdio" ? "stdio" : "http";
}
function detailOf(s: McpServerConfig): string {
  return s.endpoint || [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
}

function KeyValueRows({ rows, onChange, keyPlaceholder, valuePlaceholder }: {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const set = (i: number, patch: Partial<KV>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    // Keep one trailing empty row for adding more.
    if (i === rows.length - 1 && (patch.key || patch.value)) next.push({ ...emptyRow });
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1">
          <input
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="w-2/5 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-white/25"
          />
          <input
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-white/25"
          />
          {i < rows.length - 1 && (
            <button
              onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70"
              title="Remove"
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const fieldCls = "w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/25";
const labelCls = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/40";

export function McpServersTab() {
  const [servers, setServers] = useState<McpServerConfig[] | null>(null);
  const [status, setStatus] = useState<Record<string, McpProbeResult | "checking">>({});

  // Editor form
  const [editingName, setEditingName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [transport, setTransport] = useState<Transport>("http");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState<KV[]>([{ ...emptyRow }]);
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [env, setEnv] = useState<KV[]>([{ ...emptyRow }]);
  const [cwd, setCwd] = useState("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(() => {
    fetch("/api/mcp")
      .then((r) => r.json())
      .then((res) => setServers(res.servers ?? []))
      .catch(() => setServers([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const resetForm = useCallback(() => {
    setEditingName(null);
    setName("");
    setDescription("");
    setTransport("http");
    setEndpoint("");
    setApiKey("");
    setHeaders([{ ...emptyRow }]);
    setCommand("");
    setArgsText("");
    setEnv([{ ...emptyRow }]);
    setCwd("");
    setTestResult(null);
    setError("");
  }, []);

  const editServer = useCallback((s: McpServerConfig) => {
    setEditingName(s.name);
    setName(s.name);
    setDescription(s.description ?? "");
    setTransport(transportOf(s));
    setEndpoint(s.endpoint ?? "");
    setApiKey(s.apiKey ?? "");
    setHeaders(recordToRows(s.headers));
    setCommand(s.command ?? "");
    setArgsText((s.args ?? []).join("\n"));
    setEnv(recordToRows(s.env));
    setCwd(s.cwd ?? "");
    setTestResult(null);
    setError("");
  }, []);

  const buildConfig = useCallback((): Partial<McpServerConfig> => {
    if (transport === "stdio") {
      return {
        name: name.trim(),
        description: description.trim() || undefined,
        transport: "stdio",
        command: command.trim() || undefined,
        args: argsText.split("\n").map((s) => s.trim()).filter(Boolean),
        env: rowsToRecord(env),
        cwd: cwd.trim() || undefined,
      };
    }
    return {
      name: name.trim(),
      description: description.trim() || undefined,
      transport,
      endpoint: endpoint.trim(),
      apiKey: apiKey.trim() || undefined,
      headers: rowsToRecord(headers),
    };
  }, [transport, name, description, command, argsText, env, cwd, endpoint, apiKey, headers]);

  const test = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true, ...buildConfig() }),
      }).then((r) => r.json());
      if (res.error) setError(res.error);
      else setTestResult(res.result as McpProbeResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }, [buildConfig]);

  const save = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const cfg = buildConfig();
      if (!cfg.name) throw new Error("Name is required.");
      // When renaming an existing server, drop the old entry.
      if (editingName && editingName !== cfg.name) {
        await fetch(`/api/mcp?name=${encodeURIComponent(editingName)}`, { method: "DELETE" });
      }
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      setServers(res.servers ?? []);
      resetForm();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [buildConfig, editingName, resetForm]);

  const remove = useCallback(
    async (serverName: string) => {
      const res = await fetch(`/api/mcp?name=${encodeURIComponent(serverName)}`, { method: "DELETE" }).then((r) => r.json());
      setServers(res.servers ?? []);
      if (editingName === serverName) resetForm();
    },
    [editingName, resetForm],
  );

  const probe = useCallback(async (serverName: string) => {
    setStatus((st) => ({ ...st, [serverName]: "checking" }));
    const res = await fetch(`/api/mcp?probe=${encodeURIComponent(serverName)}`).then((r) => r.json());
    setStatus((st) => ({ ...st, [serverName]: res.result as McpProbeResult }));
  }, []);

  const importJson = useCallback(async () => {
    setError("");
    try {
      const parsed = JSON.parse(importText) as Record<string, unknown>;
      // Accept either { mcpServers: { name: {...} } } or { name: {...} }.
      const map = (parsed.mcpServers ?? parsed) as Record<string, Record<string, unknown>>;
      const entries = Object.entries(map);
      if (entries.length === 0) throw new Error("No servers found in JSON.");
      for (const [serverName, raw] of entries) {
        const r = raw as Partial<McpServerConfig> & { url?: string; type?: string };
        const cfg: Partial<McpServerConfig> = {
          name: serverName,
          description: r.description,
          transport: r.command ? "stdio" : r.type === "sse" ? "sse" : "http",
          endpoint: r.endpoint ?? r.url,
          command: r.command,
          args: r.args,
          env: r.env,
          headers: r.headers,
          apiKey: r.apiKey,
        };
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg),
        }).then((x) => x.json());
        if (res.error) throw new Error(`${serverName}: ${res.error}`);
        setServers(res.servers ?? []);
      }
      setImportText("");
      setShowImport(false);
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  }, [importText]);

  const isHttp = transport !== "stdio";
  const sortedServers = useMemo(() => [...(servers ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [servers]);

  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-white/50">
        Connect Model Context Protocol servers so the assistant can use their tools. Supports Streamable HTTP and SSE (remote, with
        an optional bearer token or custom headers like <code className="text-white/70">Private-Token</code>) and stdio (a local
        process such as <code className="text-white/70">docker</code> or <code className="text-white/70">npx</code>). Use{" "}
        <strong>Test</strong> to verify a connection and list its tools. Per-agent access is configured under Settings → Assistant.
      </p>

      {/* Configured servers */}
      <div className="space-y-1.5">
        {servers === null ? (
          <p className="text-xs text-white/40">Loading…</p>
        ) : sortedServers.length === 0 ? (
          <p className="text-xs text-white/40">No MCP servers configured yet. Add one below.</p>
        ) : (
          sortedServers.map((s) => {
            const st = status[s.name];
            return (
              <div key={s.name} className="rounded border border-white/10 bg-white/[0.03] p-2.5">
                <div className="flex items-center gap-2">
                  {st === "checking" ? (
                    <Loader2 size={13} className="shrink-0 animate-spin text-white/40" />
                  ) : st?.ok ? (
                    <PlugZap size={13} className="shrink-0 text-emerald-300" />
                  ) : (
                    <Plug size={13} className="shrink-0 text-white/30" />
                  )}
                  <span className="truncate font-medium text-white/90">{s.name}</span>
                  <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase text-white/45">
                    {transportOf(s)}
                  </span>
                  <div className="ml-auto flex shrink-0 gap-1">
                    <button onClick={() => probe(s.name)} className="rounded px-2 py-1 text-xs text-sky-200 hover:bg-white/10" title="Test connection">
                      Test
                    </button>
                    <button onClick={() => editServer(s)} className="rounded px-2 py-1 text-xs text-white/60 hover:bg-white/10">
                      Edit
                    </button>
                    <button onClick={() => remove(s.name)} className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-red-300" title="Remove">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {s.description && <p className="mt-1 text-[11px] text-white/55">{s.description}</p>}
                <p className="mt-0.5 truncate text-[11px] text-white/40">{detailOf(s)}</p>
                {st && st !== "checking" && (
                  <p className={`mt-1 text-[11px] ${st.ok ? "text-emerald-300" : "text-red-300"}`}>
                    {st.ok ? `Connected — ${st.tools?.length ?? 0} tools: ${(st.tools ?? []).join(", ")}` : `Failed: ${st.error}`}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Editor */}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="mb-3 flex items-center gap-2">
          <h4 className="text-xs font-semibold text-white/80">{editingName ? `Edit "${editingName}"` : "Add a server"}</h4>
          {editingName && (
            <button onClick={resetForm} className="rounded px-2 py-0.5 text-[11px] text-white/50 hover:bg-white/10">
              + New instead
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github-mcp-server" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls}>Transport</label>
            <select value={transport} onChange={(e) => setTransport(e.target.value as Transport)} className={fieldCls}>
              {TRANSPORTS.map((t) => (
                <option key={t.value} value={t.value} className="bg-[#0f1117]">
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-3">
          <label className={labelCls}>Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this server is for — shown to the agent, e.g. 'Tools to interact with GitLab'"
            className={fieldCls}
          />
        </div>

        {isHttp ? (
          <div className="mt-3 space-y-3">
            <div>
              <label className={labelCls}>Endpoint URL</label>
              <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://example.com/mcp" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Bearer token (optional)</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sent as Authorization: Bearer …"
                className={fieldCls}
              />
            </div>
            <div>
              <label className={labelCls}>Custom headers (optional)</label>
              <KeyValueRows rows={headers} onChange={setHeaders} keyPlaceholder="Private-Token" valuePlaceholder="value" />
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div>
              <label className={labelCls}>Command</label>
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="docker" className={fieldCls} />
            </div>
            <div>
              <label className={labelCls}>Arguments (one per line)</label>
              <textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={5}
                spellCheck={false}
                placeholder={"run\n-i\n--rm\nghcr.io/github/github-mcp-server"}
                className={`${fieldCls} resize-y font-mono`}
              />
            </div>
            <div>
              <label className={labelCls}>Environment variables (optional)</label>
              <KeyValueRows rows={env} onChange={setEnv} keyPlaceholder="GITHUB_PERSONAL_ACCESS_TOKEN" valuePlaceholder="ghp_…" />
            </div>
            <div>
              <label className={labelCls}>Working directory (optional)</label>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="defaults to the repo root" className={fieldCls} />
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle size={13} /> {error}
          </p>
        )}
        {testResult && (
          <p className={`mt-3 flex items-start gap-1.5 text-xs ${testResult.ok ? "text-emerald-300" : "text-red-300"}`}>
            {testResult.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
            <span>
              {testResult.ok
                ? `Connected — ${testResult.tools?.length ?? 0} tools: ${(testResult.tools ?? []).join(", ") || "(none)"}`
                : `Failed: ${testResult.error}`}
            </span>
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            onClick={test}
            disabled={testing || saving}
            className="flex items-center gap-1.5 rounded bg-sky-500/20 px-3 py-1.5 text-xs text-sky-100 hover:bg-sky-500/30 disabled:opacity-50"
          >
            {testing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Test connection
          </button>
          <button
            onClick={save}
            disabled={saving || testing || !name.trim()}
            className="flex items-center gap-1.5 rounded bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {editingName ? "Save" : "Add server"}
          </button>
        </div>
      </div>

      {/* Import JSON */}
      <div>
        <button onClick={() => setShowImport((v) => !v)} className="text-[11px] text-white/45 hover:text-white/70">
          {showImport ? "Hide" : "Import from JSON…"}
        </button>
        {showImport && (
          <div className="mt-2 space-y-2">
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={'{\n  "github-mcp-server": {\n    "command": "docker",\n    "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],\n    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…" }\n  }\n}'}
              className={`${fieldCls} resize-y font-mono`}
            />
            <button onClick={importJson} disabled={!importText.trim()} className="rounded bg-white/10 px-3 py-1.5 text-xs text-white/80 hover:bg-white/15 disabled:opacity-50">
              Import
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
