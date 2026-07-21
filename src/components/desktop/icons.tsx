"use client";

import * as LucideIcons from "lucide-react";
import { HelpCircle, type LucideProps } from "lucide-react";
import type { ComponentType } from "react";

const icons = LucideIcons as Record<string, unknown>;

function resolveIcon(name: string): ComponentType<LucideProps> {
  // Try exact name first (PascalCase convention), then capitalize the first
  // letter to handle lowercase names in manifests (e.g. "store" → "Store").
  const candidate =
    icons[name] ??
    icons[name.charAt(0).toUpperCase() + name.slice(1)];
  return typeof candidate === "function"
    ? (candidate as ComponentType<LucideProps>)
    : HelpCircle;
}

export function AppIcon({ name, ...props }: { name: string } & LucideProps) {
  const Cmp = resolveIcon(name);
  return <Cmp {...props} />;
}
