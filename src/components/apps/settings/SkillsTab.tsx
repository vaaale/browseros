"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, FileText, Plus, Save, Trash2 } from "lucide-react";
import type { Skill, SkillAsset } from "@/lib/agent/skills/store";

type AssetKind = "scripts" | "references";

interface DraftSkill {
  name: string;
  description: string;
  whenToUse: string;
  content: string;
  scripts: SkillAsset[];
  references: SkillAsset[];
}

const EMPTY_DRAFT: DraftSkill = {
  name: "",
  description: "",
  whenToUse: "",
  content: "",
  scripts: [],
  references: [],
};

function toDraft(s: Skill): DraftSkill {
  return {
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse ?? "",
    content: s.content,
    scripts: s.scripts ?? [],
    references: s.references ?? [],
  };
}

export function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "edit" | "new">("list");

  const loadList = useCallback(async () => {
    const res = await fetch("/api/skills").then((r) => r.json());
    setSkills(res.skills ?? []);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const back = useCallback(() => {
    setMode("list");
    setSelectedId(null);
    loadList();
  }, [loadList]);

  if (mode === "list") {
    return (
      <SkillsList
        skills={skills}
        onSelect={(id) => {
          setSelectedId(id);
          setMode("edit");
        }}
        onNew={() => {
          setSelectedId(null);
          setMode("new");
        }}
      />
    );
  }

  return (
    <SkillEditor
      key={selectedId ?? "new"}
      skillId={mode === "edit" ? selectedId : null}
      onBack={back}
      onSaved={(savedId) => {
        setSelectedId(savedId);
        setMode("edit");
        loadList();
      }}
      onDeleted={back}
    />
  );
}

function SkillsList({ skills, onSelect, onNew }: { skills: Skill[]; onSelect: (id: string) => void; onNew: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/50">
          Skills are named procedures the assistant can load on demand. Click one to edit its instructions, scripts, and
          references.
        </p>
        <button
          onClick={onNew}
          className="flex shrink-0 items-center gap-1 rounded bg-white/10 px-2.5 py-1 text-[11px] hover:bg-white/20"
        >
          <Plus size={12} /> New skill
        </button>
      </div>

      <div className="space-y-1">
        {skills.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className="group flex w-full items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-left transition-colors hover:bg-white/[0.06]"
          >
            <div className="flex-1 overflow-hidden">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-white/85">{s.name}</span>
                {typeof s.score === "number" && (
                  <span className="text-[10px] text-emerald-300/80">score {s.score.toFixed(1)}</span>
                )}
              </div>
              {s.description && <div className="mt-0.5 truncate text-xs text-white/50">{s.description}</div>}
              {s.whenToUse && <div className="mt-0.5 truncate text-[11px] text-white/40">When: {s.whenToUse}</div>}
            </div>
            <ChevronRight size={14} className="mt-1 shrink-0 text-white/30 group-hover:text-white/60" />
          </button>
        ))}
        {skills.length === 0 && (
          <p className="text-xs text-white/40">No skills yet. The assistant creates these as it learns, or add one above.</p>
        )}
      </div>
    </div>
  );
}

interface EditorProps {
  skillId: string | null;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}

function SkillEditor({ skillId, onBack, onSaved, onDeleted }: EditorProps) {
  // Parent re-mounts via `key`, so component lifecycle == single skill identity.
  const [draft, setDraft] = useState<DraftSkill>(EMPTY_DRAFT);
  const [loaded, setLoaded] = useState<boolean>(skillId === null);
  const [score, setScore] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!skillId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/skills?id=${encodeURIComponent(skillId)}`).then((r) => r.json());
      if (cancelled) return;
      const s: Skill | undefined = res.skill;
      if (s) {
        setDraft(toDraft(s));
        setScore(s.score);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  const canSave = useMemo(() => draft.name.trim().length > 0 && draft.content.trim().length > 0, [draft.name, draft.content]);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description,
          whenToUse: draft.whenToUse || undefined,
          content: draft.content,
          scripts: draft.scripts,
          references: draft.references,
          previousId: skillId ?? undefined,
        }),
      }).then((r) => r.json());
      if (res.error) {
        setStatus(`Error: ${res.error}`);
      } else {
        setStatus("Saved.");
        onSaved(res.skill.id as string);
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!skillId) return;
    if (!confirm(`Delete skill "${draft.name}"? This cannot be undone.`)) return;
    await fetch(`/api/skills?id=${encodeURIComponent(skillId)}`, { method: "DELETE" });
    onDeleted();
  };

  if (!loaded) return <p className="text-xs text-white/40">Loading…</p>;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft size={12} /> Back to skills
        </button>
        <div className="flex items-center gap-2">
          {skillId && (
            <button
              onClick={remove}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15"
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
          <button
            onClick={save}
            disabled={!canSave || saving}
            className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1 text-[11px] hover:bg-white/20 disabled:opacity-40"
          >
            <Save size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <section className="space-y-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">Skill file</h4>
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Skill name"
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
          />
        </Field>
        <Field label="Description">
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="One-line description"
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
          />
        </Field>
        <Field label="When to use">
          <input
            value={draft.whenToUse}
            onChange={(e) => setDraft({ ...draft, whenToUse: e.target.value })}
            placeholder="When this skill applies (optional)"
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
          />
        </Field>
        <Field label="Content">
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="Step-by-step instructions (Markdown)"
            rows={12}
            className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-white/30"
          />
        </Field>
        {typeof score === "number" && (
          <p className="text-[10px] text-emerald-300/70">Optimizer score: {score.toFixed(1)}</p>
        )}
      </section>

      <AssetSection
        title="Scripts"
        emptyHint="No scripts attached. Add helper code, snippets, or commands that go with this skill."
        kind="scripts"
        assets={draft.scripts}
        defaultName="script.sh"
        onChange={(next) => setDraft({ ...draft, scripts: next })}
      />

      <AssetSection
        title="References"
        emptyHint="No references attached. Add reference docs, examples, or prompts the skill can quote."
        kind="references"
        assets={draft.references}
        defaultName="reference.md"
        onChange={(next) => setDraft({ ...draft, references: next })}
      />

      {status && <p className="text-xs text-white/60">{status}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-white/40">{label}</span>
      {children}
    </label>
  );
}

interface AssetSectionProps {
  title: string;
  emptyHint: string;
  kind: AssetKind;
  assets: SkillAsset[];
  defaultName: string;
  onChange: (next: SkillAsset[]) => void;
}

function AssetSection({ title, emptyHint, kind, assets, defaultName, onChange }: AssetSectionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const updateName = (i: number, name: string) => {
    const next = assets.slice();
    next[i] = { ...next[i], name };
    onChange(next);
  };

  const updateContent = (i: number, content: string) => {
    const next = assets.slice();
    next[i] = { ...next[i], content };
    onChange(next);
  };

  const remove = (i: number) => {
    if (!confirm(`Remove ${kind === "scripts" ? "script" : "reference"} "${assets[i].name}"?`)) return;
    const next = assets.slice();
    next.splice(i, 1);
    onChange(next);
    if (openIndex === i) setOpenIndex(null);
    else if (openIndex !== null && openIndex > i) setOpenIndex(openIndex - 1);
  };

  const add = () => {
    const existing = new Set(assets.map((a) => a.name));
    let name = defaultName;
    let n = 1;
    while (existing.has(name)) {
      const dot = defaultName.lastIndexOf(".");
      name =
        dot > 0
          ? `${defaultName.slice(0, dot)}-${n}${defaultName.slice(dot)}`
          : `${defaultName}-${n}`;
      n += 1;
    }
    onChange([...assets, { name, content: "" }]);
    setOpenIndex(assets.length);
  };

  return (
    <section className="space-y-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">
          {title} ({assets.length})
        </h4>
        <button
          onClick={add}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Plus size={12} /> Add {kind === "scripts" ? "script" : "reference"}
        </button>
      </div>

      {assets.length === 0 ? (
        <p className="text-[11px] text-white/40">{emptyHint}</p>
      ) : (
        <ul className="space-y-1.5">
          {assets.map((a, i) => {
            const isOpen = openIndex === i;
            return (
              <li key={i} className="rounded border border-white/10 bg-black/20">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <button
                    onClick={() => setOpenIndex(isOpen ? null : i)}
                    className="flex flex-1 items-center gap-2 text-left text-[11px] text-white/80 hover:text-white"
                  >
                    <FileText size={12} className="text-white/40" />
                    <span className="truncate">{a.name || "(unnamed)"}</span>
                  </button>
                  <button
                    onClick={() => remove(i)}
                    className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-red-300"
                    aria-label={`Remove ${a.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {isOpen && (
                  <div className="space-y-1.5 border-t border-white/10 px-2 py-2">
                    <input
                      value={a.name}
                      onChange={(e) => updateName(i, e.target.value)}
                      placeholder="filename"
                      className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] outline-none focus:border-white/30"
                    />
                    <textarea
                      value={a.content}
                      onChange={(e) => updateContent(i, e.target.value)}
                      placeholder="File contents"
                      rows={10}
                      className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-white/30"
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
