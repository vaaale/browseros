"use client";

// A small, dependency-free illustration of how the current Context Compaction
// settings carve up a conversation. Two parts: (1) a token-budget ruler
// showing where the three thresholds fall within the assumed context window,
// and (2) a proportional bar showing the three regions a long conversation
// ends up split into — the pinned first turn, the retained block summaries,
// and the live raw tail — sized relative to each other by the current
// blockSize/maxRetainedBlocks/keepTailTurns values.

export interface CompactionBudgetIllustrationProps {
  assumedContextTokens: number;
  clearThreshold: number;
  summarizeThreshold: number;
  hardLimit: number;
  blockSize: number;
  maxRetainedBlocks: number;
  keepTailTurns: number;
}

function Marker({ pct, label, color }: { pct: number; label: string; color: string }) {
  return (
    <div className="absolute top-0 h-full" style={{ left: `${pct}%` }}>
      <div className="h-full w-px" style={{ backgroundColor: color }} />
      <div
        className="absolute top-full mt-1 -translate-x-1/2 whitespace-nowrap text-[10px]"
        style={{ color }}
      >
        {label}
      </div>
    </div>
  );
}

export function CompactionBudgetIllustration(props: CompactionBudgetIllustrationProps) {
  const { assumedContextTokens, clearThreshold, summarizeThreshold, hardLimit, blockSize, maxRetainedBlocks, keepTailTurns } = props;

  const clearPct = Math.round(clearThreshold * 100);
  const summarizePct = Math.round(summarizeThreshold * 100);
  const hardPct = Math.round(hardLimit * 100);

  const intentTurns = 1;
  const blockTurns = Math.max(0, blockSize * maxRetainedBlocks);
  const tailTurns = Math.max(0, keepTailTurns);
  const totalTurns = Math.max(1, intentTurns + blockTurns + tailTurns);
  const intentWidth = (intentTurns / totalTurns) * 100;
  const blockWidth = (blockTurns / totalTurns) * 100;
  const tailWidth = (tailTurns / totalTurns) * 100;

  return (
    <div className="flex flex-col gap-8 rounded-md border border-white/10 bg-white/[0.02] p-4">
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">Token budget</div>
        <p className="mb-6 text-[11px] leading-snug text-white/40">
          Where Layer 1 / Layer 2 / Layer 3 kick in, as a fraction of the {assumedContextTokens.toLocaleString()}-token assumed context window.
        </p>
        <div className="relative h-2 rounded-full bg-white/10">
          <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/40" style={{ width: `${clearPct}%` }} />
          <div className="absolute inset-y-0 rounded-full bg-amber-500/40" style={{ left: `${clearPct}%`, width: `${Math.max(0, summarizePct - clearPct)}%` }} />
          <div className="absolute inset-y-0 rounded-full bg-red-500/40" style={{ left: `${summarizePct}%`, width: `${Math.max(0, hardPct - summarizePct)}%` }} />
          <Marker pct={clearPct} label={`Clear ${clearPct}%`} color="#34d399" />
          <Marker pct={summarizePct} label={`Summarize ${summarizePct}%`} color="#fbbf24" />
          <Marker pct={hardPct} label={`Hard limit ${hardPct}%`} color="#f87171" />
        </div>
      </div>

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">Conversation shape</div>
        <p className="mb-2 text-[11px] leading-snug text-white/40">
          A long conversation ends up as: the original intent, up to {maxRetainedBlocks} block summaries ({blockSize} turns each), then the live tail — everything older is permanently expelled.
        </p>
        <div className="flex h-8 overflow-hidden rounded-md border border-white/10 text-[10px] font-medium text-white/80">
          <div className="flex items-center justify-center bg-violet-500/40" style={{ width: `${intentWidth}%` }} title="Pinned original intent (1 turn)">
            {intentWidth > 6 ? "Intent" : ""}
          </div>
          <div className="flex items-center justify-center border-x border-white/10 bg-sky-500/30" style={{ width: `${blockWidth}%` }} title={`Retained block summaries (${blockTurns} turns compressed)`}>
            {blockWidth > 10 ? `${maxRetainedBlocks} blocks (${blockTurns} turns)` : ""}
          </div>
          <div className="flex items-center justify-center bg-white/10" style={{ width: `${tailWidth}%` }} title={`Live raw tail (${tailTurns} turns)`}>
            {tailWidth > 6 ? "Tail" : ""}
          </div>
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-white/30">
          <span>original intent</span>
          <span>compressed history</span>
          <span>verbatim tail</span>
        </div>
      </div>
    </div>
  );
}
