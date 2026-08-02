"use client";

import type { Step4Values } from "./wizard-types";

interface Props {
  repos: Step4Values;
  onChange: (r: Step4Values) => void;
}

interface RepoRowProps {
  label: string;
  description: string;
  url: string;
  branch: string;
  onUrl: (v: string) => void;
  onBranch: (v: string) => void;
}

function RepoRow({ label, description, url, branch, onUrl, onBranch }: RepoRowProps) {
  const branchWarning = url && !branch;
  return (
    <div className="rounded border border-white/10 bg-black/20 p-4 space-y-2">
      <div>
        <span className="text-xs font-medium text-white/80">{label}</span>
        <span className="ml-2 text-[11px] text-white/40">{description}</span>
      </div>
      <div className="grid grid-cols-[1fr_140px] gap-2">
        <div>
          <label className="mb-0.5 block text-[10px] text-white/40">URL (optional)</label>
          <input
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            placeholder="https://github.com/…"
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none placeholder:text-white/20"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-white/40">Branch</label>
          <input
            value={branch}
            onChange={(e) => onBranch(e.target.value)}
            placeholder="main"
            className={`w-full rounded border px-2 py-1.5 text-xs outline-none
              ${branchWarning ? "border-amber-500/40 bg-amber-500/5" : "border-white/10 bg-black/30"}`}
          />
        </div>
      </div>
      {branchWarning && (
        <p className="text-[10px] text-amber-400/70">Enter a branch name for this URL.</p>
      )}
    </div>
  );
}

export function Step4GitRepos({ repos, onChange }: Props) {
  const set = <K extends keyof Step4Values>(key: K, field: "url" | "branch", value: string) =>
    onChange({ ...repos, [key]: { ...repos[key], [field]: value } });

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/50">
        Connect BOS to its upstream git repositories. All fields are optional — leave blank to create
        an empty local repository. These can be configured later in Settings → Versions.
      </p>

      <RepoRow
        label="BOS Source"
        description="The BrowserOS codebase itself"
        url={repos.bosSource.url}
        branch={repos.bosSource.branch}
        onUrl={(v) => set("bosSource", "url", v)}
        onBranch={(v) => set("bosSource", "branch", v)}
      />

      <RepoRow
        label="BOS Central Specs"
        description="System spec store (replaces local seed if a URL is given)"
        url={repos.bosSpecs.url}
        branch={repos.bosSpecs.branch}
        onUrl={(v) => set("bosSpecs", "url", v)}
        onBranch={(v) => set("bosSpecs", "branch", v)}
      />

      <RepoRow
        label="User Apps"
        description="Your personal apps and artifacts"
        url={repos.userApps.url}
        branch={repos.userApps.branch}
        onUrl={(v) => set("userApps", "url", v)}
        onBranch={(v) => set("userApps", "branch", v)}
      />
    </div>
  );
}
