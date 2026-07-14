import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  size?: "sm" | "md";
}

const variants: Record<Variant, string> = {
  primary: "bg-blue-600 hover:bg-blue-700 text-white border-transparent",
  secondary: "bg-gray-700 hover:bg-gray-600 text-gray-100 border-gray-600",
  danger: "bg-red-700 hover:bg-red-600 text-white border-transparent",
  ghost: "bg-transparent hover:bg-white/10 text-gray-300 border-gray-600",
};

export function Button({ variant = "primary", loading, children, className = "", disabled, size = "md", ...props }: Props) {
  return (
    <button
      className={`inline-flex items-center justify-center border rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? "…" : children}
    </button>
  );
}
