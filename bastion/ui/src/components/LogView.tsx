import { useEffect, useRef } from "react";

export function LogView({ log, className = "" }: { log: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  return (
    <pre
      ref={ref}
      className={`text-xs font-mono rounded whitespace-pre-wrap break-all ${className}`}
      style={{
        background: "#0a0a0a",
        color: "#4ade80",
        border: "1px solid #222",
        padding: "12px",
        maxHeight: "480px",
        overflowY: "auto",
        overflowX: "auto",
      }}
    >
      {log || "(no log entries yet)"}
    </pre>
  );
}
