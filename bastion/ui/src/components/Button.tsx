import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  size?: "sm" | "md";
}

const base = "inline-flex items-center justify-center rounded font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";

const variants: Record<Variant, string> = {
  primary:   "bg-[#2563eb] hover:bg-[#1d4ed8] text-white",
  secondary: "bg-[#222] hover:bg-[#2a2a2a] text-[#ccc] border border-[#444]",
  danger:    "bg-[#7f1d1d] hover:bg-[#991b1b] text-white",
  ghost:     "bg-transparent hover:bg-white/10 text-[#aaa] hover:text-[#eee]",
};

const sizes: Record<"sm" | "md", string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

export function Button({ variant = "primary", loading, children, className = "", disabled, size = "md", ...props }: Props) {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? "…" : children}
    </button>
  );
}
