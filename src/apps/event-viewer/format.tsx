export function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 45_000) return "just now";
  const m = Math.floor(d / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function MetaChip({ k, v }: { k: string; v: string }) {
  return (
    <span className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[11px] text-white/70">
      <span className="mr-1.5 text-white/40">{k}</span>
      {v}
    </span>
  );
}
