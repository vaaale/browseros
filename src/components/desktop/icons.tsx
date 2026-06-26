"use client";

import {
  Folder,
  Globe,
  Bot,
  Settings,
  Terminal,
  Code2,
  Brain,
  Wrench,
  Puzzle,
  FileText,
  HelpCircle,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";

const ICONS: Record<string, ComponentType<LucideProps>> = {
  Folder,
  Globe,
  Bot,
  Settings,
  Terminal,
  Code2,
  Brain,
  Wrench,
  Puzzle,
  FileText,
};

export function AppIcon({ name, ...props }: { name: string } & LucideProps) {
  const Cmp = ICONS[name] ?? HelpCircle;
  return <Cmp {...props} />;
}
