// The diagnostics-report format (031-self-healing FR-007/FR-028).
//
// Markdown with YAML frontmatter, for BOTH Diagnostician modes (clarification
// Q8/A8). Frontmatter carries the machine-readable verdict the spine routes on;
// the body is the human-readable investigation narrative with its source
// citations.
//
// Framework-free and pure: the parser is what stands between an LLM's output
// and a code-changing pipeline, so it is directly unit-testable and refuses
// anything it cannot fully validate.

import { OWNERSHIPS, SCOPE_CLASSES, type Ownership, type ScopeClass } from "./types";

export interface DiagnosticsFrontmatter {
  caseId: string;
  scopeClass: ScopeClass;
  ownership: Ownership;
  proposedSurface: string;
  triggeredAt?: string;
  verdict?: string;
  /** Class d/d-bis: the app the failure points at. */
  appId?: string;
}

export interface ParsedReport {
  frontmatter: DiagnosticsFrontmatter;
  body: string;
}

/**
 * Unwrap a YAML scalar.
 *
 * A DOUBLE-quoted value is parsed as JSON, not merely unwrapped — that is what
 * `renderDiagnosticsReport` writes it with, and a `proposedSurface` naming a
 * symbol in quotes (`the "ingest" handler`) has to survive a write/read round
 * trip rather than accumulating backslashes. Single quotes are the plain YAML
 * form an LLM tends to produce, so those are just unwrapped.
 */
function scalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed.trim();
    } catch {
      /* not a JSON string — fall through to the plain unwrap below */
    }
  }
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim();
}

/**
 * Parse the leading `---` fenced block as a flat key/value map. Deliberately
 * NOT a general YAML parser: the frontmatter contract is flat scalars only, and
 * accepting more would mean accepting shapes the spine can't route on.
 */
export function parseFrontmatterBlock(markdown: string): { fields: Record<string, string>; body: string } {
  const match = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(markdown ?? "");
  if (!match) return { fields: {}, body: (markdown ?? "").trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    fields[line.slice(0, sep).trim()] = scalar(line.slice(sep + 1));
  }
  return { fields, body: match[2].trim() };
}

export function isScopeClass(value: unknown): value is ScopeClass {
  return typeof value === "string" && (SCOPE_CLASSES as readonly string[]).includes(value);
}

export function isOwnership(value: unknown): value is Ownership {
  return typeof value === "string" && (OWNERSHIPS as readonly string[]).includes(value);
}

/**
 * Validate a markdown report into a routable ParsedReport, or explain exactly
 * what is missing.
 *
 * The mechanism drives code changes off this object, so a report that is
 * ALMOST right is rejected rather than coerced: a missing `proposedSurface`
 * would send the pipeline off with no target, and an invented `scopeClass`
 * would route to the wrong fix surface entirely.
 */
export function parseDiagnosticsReport(markdown: string): ParsedReport | { error: string } {
  const { fields, body } = parseFrontmatterBlock(markdown);
  if (Object.keys(fields).length === 0) {
    return { error: "the report has no YAML frontmatter block (it must start with `---`)" };
  }
  const missing: string[] = [];
  if (!isScopeClass(fields.scopeClass)) missing.push(`scopeClass (one of: ${SCOPE_CLASSES.join(", ")})`);
  if (!isOwnership(fields.ownership)) missing.push(`ownership (one of: ${OWNERSHIPS.join(", ")})`);
  if (!fields.proposedSurface) missing.push("proposedSurface (the specific file/tool/skill/workflow to modify)");
  if (missing.length) {
    return { error: `frontmatter is missing or invalid: ${missing.join("; ")}` };
  }
  if (!body) return { error: "the report body is empty — an investigation narrative is required" };
  return {
    frontmatter: {
      caseId: fields.caseId ?? "",
      scopeClass: fields.scopeClass as ScopeClass,
      ownership: fields.ownership as Ownership,
      proposedSurface: fields.proposedSurface,
      ...(fields.triggeredAt ? { triggeredAt: fields.triggeredAt } : {}),
      ...(fields.verdict ? { verdict: fields.verdict } : {}),
      ...(fields.appId ? { appId: fields.appId } : {}),
    },
    body,
  };
}

/** Compose the canonical on-disk report from validated parts, so the file BOS
 *  writes always has a complete, normalized frontmatter block regardless of how
 *  loosely the agent formatted its own. */
export function renderDiagnosticsReport(frontmatter: DiagnosticsFrontmatter, body: string): string {
  const yaml = [
    `caseId: ${frontmatter.caseId}`,
    `scopeClass: ${frontmatter.scopeClass}`,
    `ownership: ${frontmatter.ownership}`,
    `proposedSurface: ${JSON.stringify(frontmatter.proposedSurface)}`,
    `triggeredAt: ${frontmatter.triggeredAt ?? new Date().toISOString()}`,
    ...(frontmatter.verdict ? [`verdict: ${JSON.stringify(frontmatter.verdict)}`] : []),
    ...(frontmatter.appId ? [`appId: ${frontmatter.appId}`] : []),
  ].join("\n");
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

/** Where reports live (FR-028) — the same directory as Mode 1 reports. */
export const REPORTS_DIR = "/Documents/BOS Improvements";

export function reportPathFor(caseId: string): string {
  return `${REPORTS_DIR}/self-heal-${caseId}.md`;
}

/** A citation is a `path:line` or `path` reference; FR-007(b) requires at
 *  least one for every claim about BOS's current behavior. This is the
 *  cheap, deterministic check that the narrative cites SOMETHING — it cannot
 *  judge whether the citation is apt, only that the agent did the work of
 *  pointing at a file. */
export function hasSourceCitation(body: string): boolean {
  return /(^|[\s(`])(src|seed|docs|tests|e2e|tools|specs)\/[\w./-]+(:\d+)?/i.test(body) || /\bspec(ification)?\s+\d{3}\b/i.test(body);
}
