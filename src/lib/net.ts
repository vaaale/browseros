import "server-only";

// Basic SSRF guard shared by the browser proxy and the agent's web_fetch tool.
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".home") || h.endsWith(".internal")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "0.0.0.0" || h === "::1") return true;
  return false;
}

// ── HTML → Markdown ──────────────────────────────────────────────────────────
// Used ONLY on the fallback path: when the configured provider has no native
// web-fetch server tool (i.e. anything non-Anthropic — a self-hosted or
// OpenAI-compatible endpoint), BOS has to fetch and clean the page itself.
//
// Deliberately dependency-free (CLAUDE.md: don't touch package.json unless
// asked), so this is a pragmatic converter, not a spec-complete one. The bar it
// has to clear is "an agent can read this and follow its links" — which the
// previous implementation missed badly, since it deleted every tag including
// every <a href>, leaving prose with all its references silently removed.

const BLOCK_CLOSE = /<\/(p|div|section|article|header|footer|main|aside|nav|ul|ol|dl|table|tr|blockquote|pre|figure|form)\s*>/gi;

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
  "&laquo;": "«", "&raquo;": "»", "&ldquo;": "“", "&rdquo;": "”", "&lsquo;": "‘", "&rsquo;": "’",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => {
      const named = ENTITIES[m.toLowerCase()];
      if (named !== undefined) return named;
      const num = /^&#(\d+);$/.exec(m);
      if (num) {
        const code = Number(num[1]);
        // Guard against invalid code points; leave the raw entity if unusable.
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return m;
          }
        }
      }
      return m;
    });
}

/** Resolve a possibly-relative href against the page URL; leave it as-is if unparseable. */
function absolutize(href: string, base: string | undefined): string {
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * Convert an HTML document to markdown-ish text, preserving the structure an
 * agent actually needs: link targets, headings, and list/paragraph boundaries.
 * `baseUrl` (the fetched URL) is used to absolutize relative hrefs — a bare
 * `[docs](/guide)` is useless to a caller that then wants to fetch it.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let s = html;

  // Drop content that is never page text. <head> goes too, except we lift the
  // <title> out first so the result still identifies the document.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim();
  s = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|canvas|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "");

  // Inline structure, innermost-meaningful-first.
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(h[1-6])\s*>/gi, "\n\n")
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    // Links: keep the text, append the target. Skip empty-text links (icons,
    // anchors) rather than emitting a bare "[](url)" that just adds noise.
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = decodeEntities(text.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      const target = href.trim();
      if (!label) return "";
      if (!target || target.startsWith("javascript:") || target.startsWith("#")) return label;
      return `[${label}](${absolutize(target, baseUrl)})`;
    })
    .replace(/<(strong|b)\s*[^>]*>([\s\S]*?)<\/\1\s*>/gi, "**$2**")
    .replace(/<(em|i)\s*[^>]*>([\s\S]*?)<\/\1\s*>/gi, "*$2*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(BLOCK_CLOSE, "\n\n");

  // Everything else: drop the tag, keep the text.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  // Whitespace normalization: trim each line, collapse runs of blank lines, and
  // collapse intra-line runs of spaces (without eating the newlines that now
  // carry the document's structure).
  s = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return title && !s.startsWith(`# ${title}`) ? `# ${title}\n\n${s}` : s;
}

/** Cap on locally-fetched content. Generous: the point of a fetch is to READ
 *  the page, and a document that gets cut in half is worse than useless. When
 *  it does bite, the caller is TOLD (see fetchText) rather than silently handed
 *  a truncated document it will treat as complete. */
const DEFAULT_MAX_CHARS = 1_500_000;

/**
 * Fetch a URL and return readable content — HTML converted to markdown with
 * links preserved, anything else returned verbatim.
 *
 * This is the FALLBACK path. When the provider offers a native web-fetch server
 * tool, prefer it (see `webFetch` in lib/agent/web-search.ts): the provider does
 * the extraction itself and returns cleaner output than any local converter.
 */
export async function fetchText(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Only http/https is supported");
  if (isBlockedHost(target.hostname)) throw new Error(`Host ${target.hostname} is blocked`);
  const res = await fetch(target, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BrowserOS/0.1)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());

  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const out = contentType.includes("html") ? htmlToMarkdown(raw, res.url || target.toString()) : raw;

  if (out.length <= maxChars) return out;
  // Never silently truncate: a caller that isn't told will summarize half a
  // document as if it were the whole thing.
  const omitted = out.length - maxChars;
  return `${out.slice(0, maxChars)}\n\n[... truncated: ${omitted} more characters were not included. Fetch a more specific URL, or ask for the remainder.]`;
}
