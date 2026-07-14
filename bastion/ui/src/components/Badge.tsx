const styles: Record<string, { bg: string; color: string }> = {
  running:        { bg: "#4ade8022", color: "#4ade80" },
  stopped:        { bg: "#f8717122", color: "#f87171" },
  provisioning:   { bg: "#fbbf2422", color: "#fbbf24" },
  failed:         { bg: "#f8717122", color: "#f87171" },
  unknown:        { bg: "#94a3b822", color: "#94a3b8" },
  not_provisioned:{ bg: "#55555522", color: "#888" },
};

export function Badge({ status }: { status: string }) {
  const s = styles[status] ?? styles.unknown;
  return (
    <span
      style={{ background: s.bg, color: s.color }}
      className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold"
    >
      {status}
    </span>
  );
}
