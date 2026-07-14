import { useEffect, useRef } from "react";

export function LogView({ log, className = "" }: { log: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  return (
    <pre
      ref={ref}
      className={`bg-gray-950 text-green-400 text-xs font-mono p-3 rounded-md overflow-auto max-h-80 whitespace-pre-wrap break-all border border-gray-800 ${className}`}
    >
      {log || "(no log entries yet)"}
    </pre>
  );
}
