"use client";

import { Loader2 } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import { ScopeClassBadge } from "./ScopeClassBadge";
import type { HealingCase } from "@/lib/self-heal/types";

// The class-e / class-d-bis action card (031-self-healing FR-022d,
// mockup.html §2 card 3).
//
// The note about Promote is not decoration. FR-024 says the mechanism never
// promotes, and this card is where a user who just read "fix ready" looks for a
// Promote button — so it says, in place, where promotion actually lives (the
// Topbar's version controls) rather than growing a second promote path here.

export function PreviewStatus({ record }: { record: HealingCase }) {
  const launch = useOSStore((s) => s.launch);
  const branch = record.activeFeatureBranch;
  const building = record.status === "bs-pipeline";
  const ready = record.status === "preview-ready";
  const failed = record.status === "failed";

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-3" data-testid="self-heal-preview-status">
      <div className="flex items-center gap-2">
        <ScopeClassBadge scopeClass={record.scopeClass} />
        <span className="text-xs font-semibold text-white">{record.scopeClass === "d-bis" ? "App rebuild status" : "Preview status"}</span>
      </div>

      <div className="text-[11px]">
        {building ? (
          <span className="inline-flex items-center gap-1.5 text-violet-300">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Building — the pipeline is running unattended
          </span>
        ) : ready ? (
          <span className="text-emerald-300">Ready to review</span>
        ) : failed ? (
          <span className="text-red-400">Failed — see the reason below. There is no automatic retry.</span>
        ) : (
          <span className="text-white/50">{record.status}</span>
        )}
      </div>

      {branch ? (
        <div className="font-mono text-[10px] text-white/50">branch · {branch}</div>
      ) : record.appId ? (
        <div className="font-mono text-[10px] text-white/50">app · {record.appId}</div>
      ) : null}

      {record.fixSummary ? (
        <p className="rounded-md border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] leading-snug text-white/75">
          {record.fixSummary}
        </p>
      ) : null}

      {record.error ? (
        <p className="rounded-md border border-red-400/25 bg-red-400/10 px-2.5 py-2 text-[11px] leading-snug text-red-200">
          {record.error}
        </p>
      ) : null}

      {ready && branch ? (
        <>
          <button
            data-testid="self-heal-open-versions"
            onClick={() => launch("settings", { tab: "self-modification", branch })}
            className="self-start rounded-md border border-violet-500/40 bg-violet-500/20 px-2.5 py-1 text-[11px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/30"
          >
            Pin &amp; open preview
          </button>
          <p className="text-[10px] leading-snug text-white/40">
            Promote and Discard live in the Topbar&apos;s version controls — self-healing never promotes a fix for you
            (FR-024). Pin the preview, try it, then promote it there if you are happy.
          </p>
        </>
      ) : null}

      {ready && !branch && record.appId ? (
        <p className="text-[10px] leading-snug text-white/40">
          The rebuilt item is installed. Open it and check the fix; if it is wrong, rebuild or reinstall the item from
          Settings → Apps.
        </p>
      ) : null}
    </div>
  );
}
