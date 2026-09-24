"use client";

import { useState } from "react";
import type { HealingCase } from "@/lib/self-heal/types";

// The suspended action card (031-self-healing FR-016/FR-022e, mockup.html §2
// card 4).
//
// The amber border + pulse is a BINDING visual decision (design §8): a
// suspended case is the ONE self-heal state that blocks everything — it holds
// the single pipeline slot until it is answered or times out — so it has to be
// impossible to miss in a list of otherwise-passive cases.

export function SuspendedCard({
  record,
  busy,
  onSubmit,
}: {
  record: HealingCase;
  busy?: boolean;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  // An ABSOLUTE timestamp, not a "waiting 4h" age: `Date.now()` during render
  // is an impure call (and would be wrong the moment React re-rendered without
  // it changing). The suspended-timeout is measured server-side anyway.
  const suspendedAt = record.suspendedAt ? new Date(record.suspendedAt).toLocaleString() : "";

  return (
    <div
      className="flex animate-pulse flex-col gap-2.5 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] p-3 [animation-duration:3s]"
      data-testid="self-heal-suspended-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">Suspended · decision needed</span>
        {suspendedAt ? <span className="text-[10px] text-amber-200/60">since {suspendedAt}</span> : null}
      </div>
      <div className="text-xs font-semibold text-amber-100">Waiting on you</div>
      <div className="rounded-md border border-white/10 bg-black/40 px-2.5 py-2 text-[11px] leading-snug whitespace-pre-wrap text-white/80">
        {record.pendingQuestion ?? "(the question was not recorded — read the report below)"}
      </div>
      <textarea
        data-testid="self-heal-answer-input"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={3}
        placeholder="Your answer…"
        spellCheck={false}
        className="w-full resize-y rounded-md border border-white/15 bg-black/40 px-2.5 py-2 text-[11px] text-white/85 outline-none focus:border-amber-400/50"
      />
      <button
        data-testid="self-heal-submit-answer"
        disabled={busy || !answer.trim()}
        onClick={() => onSubmit(answer.trim())}
        className="self-start rounded-md border border-amber-400/40 bg-amber-400/20 px-2.5 py-1 text-[11px] font-semibold text-amber-100 transition-colors hover:bg-amber-400/30 disabled:opacity-40"
      >
        Submit answer
      </button>
      <p className="text-[10px] leading-snug text-amber-200/50">
        The fix pipeline is parked until you answer, and this case is holding the single pipeline slot — no other
        automatic fix starts meanwhile.
      </p>
    </div>
  );
}
