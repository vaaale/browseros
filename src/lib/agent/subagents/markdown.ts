// Minimal YAML-frontmatter parser/serializer for agent/skill markdown.
// Supports scalar values and simple lists ([a, b] inline or "- item" blocks).

export interface Frontmatter {
  meta: Record<string, string | string[]>;
  body: string;
}

export function parseFrontmatter(src: string): Frontmatter {
  const m = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src.trim() };

  const meta: Record<string, string | string[]> = {};
  let lastKey: string | null = null;
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && lastKey) {
      const cur = meta[lastKey];
      meta[lastKey] = Array.isArray(cur) ? [...cur, listItem[1].trim()] : [listItem[1].trim()];
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      const val = kv[2].trim();
      if (val === "") meta[lastKey] = [];
      else if (val.startsWith("[") && val.endsWith("]"))
        meta[lastKey] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      else meta[lastKey] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: m[2].trim() };
}

export function buildFrontmatter(
  meta: Record<string, string | string[] | boolean | undefined>,
  body: string,
): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else if (typeof v === "boolean") lines.push(`${k}: ${v ? "true" : "false"}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

export function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v[0] ?? undefined) : v;
}

export function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : v ? [v] : undefined;
}

/** Parse a frontmatter value as a boolean. Returns undefined when unset so
 *  callers can distinguish "not provided" from an explicit false. */
export function asBool(v: string | string[] | undefined): boolean | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const norm = s.trim().toLowerCase();
  if (norm === "true" || norm === "yes" || norm === "1") return true;
  if (norm === "false" || norm === "no" || norm === "0") return false;
  return undefined;
}
