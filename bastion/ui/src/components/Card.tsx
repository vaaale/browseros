import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      style={{ background: "#1a1a1a", border: "1px solid #333" }}
      className={`rounded-lg p-5 ${className}`}
    >
      {children}
    </div>
  );
}
