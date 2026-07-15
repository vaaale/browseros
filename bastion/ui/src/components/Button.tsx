import { useState, type ButtonHTMLAttributes, type CSSProperties } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  size?: "sm" | "md";
}

const palette: Record<Variant, { bg: string; hover: string; color: string; border: string }> = {
  primary:   { bg: "#2563eb", hover: "#1d4ed8", color: "#fff",  border: "transparent" },
  secondary: { bg: "#222",    hover: "#2a2a2a", color: "#ccc",  border: "#444" },
  danger:    { bg: "#7f1d1d", hover: "#991b1b", color: "#fff",  border: "transparent" },
  ghost:     { bg: "transparent", hover: "rgba(255,255,255,0.08)", color: "#aaa", border: "transparent" },
};

const sizes: Record<"sm" | "md", CSSProperties> = {
  sm: { padding: "4px 10px", fontSize: 12 },
  md: { padding: "6px 14px", fontSize: 13 },
};

export function Button({ variant = "primary", loading, children, style, disabled, size = "md", ...props }: Props) {
  const [hover, setHover] = useState(false);
  const p = palette[variant];
  const isDisabled = disabled || loading;

  const merged: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    fontWeight: 500,
    border: `1px solid ${p.border}`,
    background: hover && !isDisabled ? p.hover : p.bg,
    color: p.color,
    cursor: isDisabled ? "not-allowed" : "pointer",
    opacity: isDisabled ? 0.4 : 1,
    transition: "background-color .12s",
    whiteSpace: "nowrap",
    ...sizes[size],
    ...style,
  };

  return (
    <button
      style={merged}
      disabled={isDisabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...props}
    >
      {loading ? "…" : children}
    </button>
  );
}
