"use client";

// 050 T010-T013 — the Repositories page.
//
// Organised by REPOSITORY, not by filesystem. Each row leads with the two
// things the old layout needed a click to answer: what KIND this is, and
// whether it has work that is not saved or pushed. Remotes stay, demoted to a
// detail inside a repository rather than the page's organising principle.
//
// The Supervisor's version controls (preview/promote/pin/discard) are NOT here.
// They are about BrowserOS versions rather than repositories, and keeping them
// on this page is what made the old one hard to read.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ChevronDown, ChevronUp, Code, Download, FilePlus2, FolderGit2, GitBranch,
  GitMerge, Lock, MoreHorizontal, Pencil, Plus, Send, Store, Trash2, ArrowUp, EyeOff, Loader2,
} from "lucide-react";
import { useGitRemotes, FilesystemCard, type GitFsInstance, type GitRemote } from "./versions/GitRemotesTab";
import { useOSStore } from "@/store/os-provider";

interface Repo {
  id: string;
  label: string;
  kind: string;
  bindingScope: string;
  repoRoot: string;
  branch?: string;
  /** Every `bos/*` branch that EXISTS here — not just the checked-out one.
   *  "Which repositories does my feature touch" is the question asked of this
   *  page, and `branch` answers a different one. */
  featureBranches?: string[];
  /** Feature branches in a repository that should never carry one. */
  strayBranches?: string[];
  uncommitted?: number;
  unpushed?: number;
  workflow?: string;
  itemCount?: number;
  writable: boolean;
  removable: boolean;
  broken?: boolean;
  problem?: string;
  workflowMissing?: boolean;
}

interface Workflow { qualified: string; label: string; }

const GROUPS: Array<{ title: string; kinds: string[] }> = [
  // "source" is BrowserOS's own checkout — the repository every other one on
  // this page is ultimately in service of, and the one whose uncommitted work is
  // most worth seeing at a glance.
  { title: "BrowserOS", kinds: ["system", "user-specs", "source"] },
  { title: "Marketplaces", kinds: ["marketplace"] },
  { title: "Projects", kinds: ["arbitrary", "unknown"] },
];

const KIND_LABEL: Record<string, string> = {
  source: "BrowserOS source",
  system: "BOS specs",
  "user-specs": "Your BOS specs",
  marketplace: "Marketplace",
  arbitrary: "Project",
  unknown: "Unknown",
};

function KindIcon({ kind }: { kind: string }) {
  const cls = "h-3.5 w-3.5 text-white/40";
  if (kind === "source") return <Code className={cls} />;
  if (kind === "system") return <Lock className={cls} />;
  if (kind === "marketplace") return <Store className={cls} />;
  if (kind === "user-specs") return <GitBranch className={cls} />;
  return <FolderGit2 className={cls} />;
}

/** The remote a repository-level Pull/Push acts on.
 *
 *  `origin` by name when present, else the only one. With several non-origin
 *  remotes there is no defensible default, so the row shows no Pull/Push at all
 *  and the expanded Remotes section — where each one has its own buttons — is
 *  the only way to act. Picking "the first" would quietly push somewhere the
 *  user did not choose. */
function primaryRemote(remotes: GitRemote[] | undefined): GitRemote | undefined {
  if (!remotes?.length) return undefined;
  return remotes.find((r) => r.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
}

/** A `…` menu, closed on outside click or Escape like every other menu in BOS. */
function OverflowMenu({ items }: { items: Array<{ label: string; danger?: boolean; onSelect: () => void }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded p-1.5 text-white/60 hover:bg-white/10" title="More">
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-md border border-white/10 bg-[#1b1d27] py-1 text-xs shadow-xl">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => { setOpen(false); it.onSelect(); }}
              className={`block w-full px-3 py-1.5 text-left ${it.danger ? "text-red-300 hover:bg-red-500/15" : "text-white/80 hover:bg-white/10"}`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dirty/unpushed at a glance — the reason this page was reorganised. */
function StateBadges({ repo }: { repo: Repo }) {
  // A stray branch counts against "clean": it is a repository holding work it
  // should never have been given, which is exactly what this row is for saying.
  const clean =
    !repo.broken && !repo.workflowMissing && !repo.uncommitted && !repo.unpushed && !repo.strayBranches?.length;
  return (
    <>
      {repo.kind === "system" && (
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40">read-only</span>
      )}
      {repo.workflowMissing && (
        <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-100">workflow not installed</span>
      )}
      {!!repo.uncommitted && (
        <span className="inline-flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-100">
          <Pencil className="h-2.5 w-2.5" /> {repo.uncommitted} uncommitted
        </span>
      )}
      {!!repo.featureBranches?.length && (
        <span className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-white/50">
          <GitBranch className="h-2.5 w-2.5" /> {repo.featureBranches.length} feature branch{repo.featureBranches.length === 1 ? "" : "es"}
        </span>
      )}
      {!!repo.strayBranches?.length && (
        <span
          className="inline-flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-amber-200"
          title={`Should not be here: ${repo.strayBranches.join(", ")}. Reported, not deleted — they may carry commits, and they are yours.`}
        >
          <AlertTriangle className="h-2.5 w-2.5" /> {repo.strayBranches.length} stray
        </span>
      )}
      {!!repo.unpushed && (
        <span className="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-200">
          <ArrowUp className="h-2.5 w-2.5" /> {repo.unpushed} unpushed
        </span>
      )}
      {clean && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-200">clean</span>}
    </>
  );
}

/** One repository: the glance line, the actions, and its remotes on demand. */
function RepoRow({ repo, remotes, busy, onRemove, onOpenMarketplace }: {
  repo: Repo;
  remotes: ReturnType<typeof useGitRemotes>;
  busy: boolean;
  onRemove: () => void;
  onOpenMarketplace: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // The remotes API is keyed by GitFS instance id, which for a spec store IS the
  // store id — so a repository's remotes are the ones tagged with its own id.
  const fs: GitFsInstance | undefined = useMemo(
    () => remotes.filesystems.find((f) => f.id === repo.id),
    [remotes.filesystems, repo.id],
  );
  const mine = fs ? remotes.remotesByFs[fs.id] : undefined;
  const primary = primaryRemote(mine);
  const canSync = Boolean(fs && primary && !repo.broken);

  const menu = [
    ...(fs ? [{ label: expanded ? "Hide remotes" : "Show remotes", onSelect: () => setExpanded((v) => !v) }] : []),
    ...(repo.removable ? [{ label: "Remove…", danger: true, onSelect: onRemove }] : []),
  ];

  const btn = "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40";
  return (
    <div className={`rounded-lg border bg-white/[0.03] ${repo.broken || repo.problem ? "border-amber-400/20" : "border-white/10"}`}>
      <div className={`flex items-start justify-between gap-3 p-3 ${expanded ? "border-b border-white/10" : ""}`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <KindIcon kind={repo.kind} />
            <span className="text-[13px] font-medium">{repo.label}</span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/50">{KIND_LABEL[repo.kind] ?? repo.kind}</span>
            <StateBadges repo={repo} />
          </div>
          <div className="mt-1 truncate text-[11px] text-white/40" title={repo.repoRoot}>
            {repo.repoRoot}{repo.branch ? ` · ${repo.branch}` : ""}
          </div>
          {repo.kind === "system" ? (
            <div className="mt-1 text-[10px] text-white/30">The specifications BrowserOS ships with. Not editable, and cannot be removed.</div>
          ) : repo.kind === "source" ? (
            // Not "one workflow for everything in it": BrowserOS's source binds
            // no workflow at all, because it is code rather than a spec store.
            // The specs that drive changes to it live in user-specs.
            <div className="mt-1 text-[10px] text-white/30">
              BrowserOS&apos;s own code. Changes ride a <span className="text-white/50">bos/*</span> feature branch; their specs live in user-specs.
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-white/30">
              {repo.itemCount !== undefined && <>{repo.itemCount} items · </>}
              {repo.bindingScope === "project" ? "each item binds its own workflow" : "one workflow for everything in it"}
              {repo.workflow && <> · <span className="text-white/50">{repo.workflow}</span></>}
            </div>
          )}
          {repo.problem && (
            <div className="mt-2 flex items-center gap-2 rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1.5 text-[11px] text-amber-100">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="flex-1">{repo.problem}</span>
              {repo.workflowMissing && (
                <button onClick={onOpenMarketplace} className="shrink-0 rounded bg-amber-400/20 px-2 py-1 text-[11px] font-medium hover:bg-amber-400/30">
                  Open Marketplace
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {canSync && (
            <>
              <button
                disabled={busy || remotes.busyAction !== null}
                onClick={() => remotes.pull(fs!, primary!)}
                className={`${btn} bg-white/10 hover:bg-white/20`}
                title={`Pull from ${primary!.name}`}
              >
                {remotes.busyAction === `fetch-${fs!.id}-${primary!.name}` ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                Pull
              </button>
              <button
                disabled={busy || remotes.busyAction !== null}
                onClick={() => remotes.push(fs!, primary!)}
                className={`${btn} bg-sky-500/20 hover:bg-sky-500/30`}
                title={`Push to ${primary!.name}`}
              >
                {remotes.busyAction === `push-${fs!.id}-${primary!.name}` ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />}
                Push
              </button>
            </>
          )}
          {fs && (
            <button onClick={() => setExpanded((v) => !v)} className="rounded p-1.5 text-white/60 hover:bg-white/10" title={expanded ? "Hide remotes" : "Show remotes"}>
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          <OverflowMenu items={menu} />
        </div>
      </div>

      {/* Remotes are a DETAIL inside a repository, not the page's spine — which
          is what a single flat list of them at the bottom made them. */}
      {expanded && fs && (
        <FilesystemCard
          embedded
          fs={fs}
          remotes={mine}
          busyAction={remotes.busyAction}
          msg={remotes.msgByFs[fs.id] ?? null}
          onAdd={() => remotes.openAdd(fs)}
          onEdit={(remote) => remotes.openEdit(fs, remote)}
          onAction={(action, remote) => remotes.remoteAction(fs.id, action, remote)}
          onPull={(remote) => remotes.pull(fs, remote)}
          onPush={(remote) => remotes.push(fs, remote)}
        />
      )}
    </div>
  );
}

export function RepositoriesTab() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Repo | null>(null);
  // One instance for the whole page: every Pull/Push/Adopt/force-push dialog it
  // can raise is rendered once, at the bottom, rather than per row.
  const remotes = useGitRemotes();
  const launch = useOSStore((s) => s.launch);
  // A repository bound to a workflow that is not installed is intact but
  // unreadable. The one action that fixes it is installing the pack, so the
  // banner offers the place that does it rather than describing it.
  const openMarketplace = useCallback(() => { launch("marketplace"); }, [launch]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/repositories");
      const d = (await r.json()) as { repositories?: Repo[]; error?: string };
      if (!r.ok) throw new Error(d.error ?? "Could not load repositories.");
      setRepos(d.repositories ?? []);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await load();
      try {
        const r = await fetch("/api/methods");
        const d = (await r.json()) as { methods?: Array<{ id: string; label: string }> };
        if (alive) setWorkflows((d.methods ?? []).map((m) => ({ qualified: m.id, label: m.label })));
      } catch {
        // The workflow list is a convenience on the Add dialog — an empty one
        // still lets the user register with the default. Not silent: the add
        // itself reports any real failure.
        if (alive) setWorkflows([]);
      }
    })();
    return () => { alive = false; };
  }, [load]);

  const op = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      setError("");
      try {
        const r = await fetch("/api/repositories", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = (await r.json()) as { error?: string };
        // Show the server's refusal verbatim — each one names WHY (already
        // registered, nested, not removable), and paraphrasing loses the part
        // that tells the user what to do instead.
        if (!r.ok) { setError(d.error ?? "Failed."); return false; }
        await load();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold">Repositories</h3>
          <p className="mt-0.5 text-[11px] text-white/40">
            Every git repository BrowserOS knows about — its kind, its branch, and whether it has work that is not saved or pushed.
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded bg-violet-500/80 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500"
        >
          <Plus size={12} /> Add repository
        </button>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-auto p-4">
        {repos === null ? (
          <div className="flex items-center gap-2 text-[11px] text-white/40"><Loader2 size={12} className="animate-spin" /> Loading…</div>
        ) : (
          GROUPS.map((g) => {
            const rows = repos.filter((r) => g.kinds.includes(r.kind));
            if (!rows.length && g.title !== "Projects") return null;
            return (
              <div key={g.title}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">{g.title}</h3>
                {rows.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-8 text-center">
                    <FolderGit2 className="mx-auto h-6 w-6 text-white/20" />
                    <p className="mt-2 text-xs text-white/60">No projects yet</p>
                    <p className="mx-auto mt-1 max-w-[420px] text-[11px] text-white/40">
                      Add a repository to work on something that is not BrowserOS itself — an app, a service, anything
                      with a git repo. BrowserOS writes its specs into a folder the workflow chooses, and every change
                      lands on a feature branch.
                    </p>
                    <button
                      onClick={() => setAdding(true)}
                      className="mt-3 inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500"
                    >
                      <Plus size={12} /> Add repository
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {rows.map((repo) => (
                      <RepoRow
                        key={repo.id}
                        repo={repo}
                        remotes={remotes}
                        busy={busy}
                        onRemove={() => setRemoving(repo)}
                        onOpenMarketplace={openMarketplace}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {adding && <AddDialog workflows={workflows} busy={busy} onClose={() => setAdding(false)} onAdd={op} />}
      {removing && <RemoveDialog repo={removing} busy={busy} onClose={() => setRemoving(null)} onRemove={op} />}
      {/* Adopt / force-push / add-remote / edit-remote, once for the page. */}
      {remotes.dialogs}
    </div>
  );
}

function AddDialog({ workflows, busy, onClose, onAdd }: {
  workflows: Workflow[];
  busy: boolean;
  onClose: () => void;
  onAdd: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"clone" | "init">("clone");
  const [url, setUrl] = useState("");
  const [id, setId] = useState("");
  const [kind, setKind] = useState("arbitrary");
  const [provider, setProvider] = useState("");
  // Shown beside "Detect from URL" so the choice is visible before submitting,
  // rather than something the user discovers went wrong on the first pull.
  const detected = url.includes("github.com") ? "GitHub" : /gitlab\./.test(url) ? "GitLab" : url ? "Generic" : "";
  const [workflow, setWorkflow] = useState("");

  const field = "min-w-0 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30";
  const choice = (on: boolean) => `rounded border p-3 text-left ${on ? "border-white/30 bg-white/10" : "border-white/10 bg-black/30 hover:bg-white/5"}`;

  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Wider than the 460px default: this form has a label column plus long
          option text, and at 460 the Kind select overflowed the panel. */}
      <div className="w-[560px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#15171e] p-6 text-sm shadow-2xl">
        <h4 className="text-[13px] font-semibold">Add repository</h4>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => setMode("clone")} className={choice(mode === "clone")}>
            <div className="flex items-center gap-1.5 text-xs font-medium"><GitMerge size={14} /> Clone existing</div>
            <p className="mt-1 text-[11px] text-white/40">From a git URL you already have.</p>
          </button>
          <button onClick={() => setMode("init")} className={choice(mode === "init")}>
            <div className="flex items-center gap-1.5 text-xs font-medium"><FilePlus2 size={14} /> Create new</div>
            <p className="mt-1 text-[11px] text-white/40">Start an empty repository here.</p>
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          {mode === "clone" && (
            <div className="grid grid-cols-[140px_1fr] items-center gap-2">
              <label className="text-xs text-white/60">Repository URL</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:you/app.git" className={field} />
            </div>
          )}
          <div className="grid grid-cols-[140px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Name</label>
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-app" className={field} />
          </div>
          {mode === "clone" && (
            <div className="grid grid-cols-[140px_1fr] items-center gap-2">
              <label className="text-xs text-white/60">Provider</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className={field}>
                <option value="">Detect from URL{detected ? ` (${detected})` : ""}</option>
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
                <option value="generic">Generic</option>
              </select>
            </div>
          )}
          <div className="grid grid-cols-[140px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
              <option value="arbitrary">Project</option>
              <option value="marketplace">Marketplace</option>
            </select>
          </div>
          <div className="grid grid-cols-[140px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Workflow</label>
            <select value={workflow} onChange={(e) => setWorkflow(e.target.value)} className={field}>
              <option value="">Default</option>
              {workflows.map((w) => <option key={w.qualified} value={w.qualified}>{w.label}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-3 space-y-1.5 rounded border border-white/10 bg-black/20 px-2.5 py-2 text-[11px] text-white/50">
          <p>
            {kind === "marketplace"
              ? "A marketplace holds many items, and each one picks its own workflow."
              : "A project repository is one project, and picks one workflow for all of it."}
          </p>
          <p>
            Specs are written into a folder the workflow chooses — the rest of the repository is left alone, and every
            change lands on a feature branch.
          </p>
          {provider !== "generic" && (provider || detected !== "Generic") && detected && (
            <p>Credentials come from <span className="text-white/70">Settings → Integrations → Git Providers</span>.</p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Cancel</button>
          <button
            disabled={busy || !id.trim() || (mode === "clone" && !url.trim())}
            onClick={async () => {
              const ok = await onAdd({
                op: "add",
                id: id.trim(),
                kind,
                url: mode === "clone" ? url.trim() : undefined,
                provider: mode === "clone" && provider ? provider : undefined,
                workflow: workflow || undefined,
              });
              if (ok) onClose();
            }}
            className="rounded bg-violet-500/80 px-3 py-1.5 text-xs font-medium hover:bg-violet-500 disabled:opacity-40"
          >
            {mode === "clone" ? "Clone and add" : "Create and add"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** FR-007: forget and delete are DIFFERENT, and the dialog says so. There is no
 *  single "remove" button, because it would silently be one of the two. */
function RemoveDialog({ repo, busy, onClose, onRemove }: {
  repo: Repo;
  busy: boolean;
  onClose: () => void;
  onRemove: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"forget" | "delete">("forget");
  const go = async () => {
    if (await onRemove({ op: "remove", id: repo.id, mode })) onClose();
  };
  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[460px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#15171e] p-6 text-sm shadow-2xl">
        <h4 className="text-[13px] font-semibold">Remove “{repo.label}”</h4>
        <p className="mt-1 text-[11px] text-white/50">These are different. Choose deliberately.</p>

        <div className="mt-4 space-y-2">
          <button onClick={() => setMode("forget")} className={`w-full rounded border p-3 text-left ${mode === "forget" ? "border-white/30 bg-white/10" : "border-white/10 bg-black/30 hover:bg-white/5"}`}>
            <div className="flex items-center gap-1.5 text-xs font-medium"><EyeOff size={14} /> Forget it</div>
            <p className="mt-1 text-[11px] text-white/40">BrowserOS stops tracking it. <b className="text-white/70">The files stay on disk.</b></p>
          </button>
          <button onClick={() => setMode("delete")} className={`w-full rounded border p-3 text-left ${mode === "delete" ? "border-rose-500/40 bg-rose-500/15" : "border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10"}`}>
            <div className="flex items-center gap-1.5 text-xs font-medium text-rose-200"><Trash2 size={14} /> Delete it</div>
            <p className="mt-1 text-[11px] text-rose-200/70">Removes the working copy from disk.</p>
          </button>
        </div>

        {!!repo.unpushed && (
          <div className="mt-3 flex items-start gap-2 rounded border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-100">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>
              This repository has <b>{repo.unpushed} commit(s) that no remote has</b>. Push first if you want to keep that work.
            </span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Cancel</button>
          <button disabled={busy} onClick={() => void go()} className={`rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${mode === "delete" ? "bg-rose-500/20 text-rose-200 hover:bg-rose-500/30" : "bg-white/10 hover:bg-white/20"}`}>
            {mode === "delete" ? "Delete" : "Forget"}
          </button>
        </div>
      </div>
    </div>
  );
}
