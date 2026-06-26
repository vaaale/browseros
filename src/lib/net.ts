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

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch a URL and return readable text (HTML is stripped to plain text). */
export async function fetchText(url: string, maxBytes = 200_000): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Only http/https is supported");
  if (isBlockedHost(target.hostname)) throw new Error(`Host ${target.hostname} is blocked`);
  const res = await fetch(target, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BrowserOS/0.1)" },
    redirect: "follow",
  });
  const contentType = res.headers.get("content-type") ?? "";
  let text = await res.text();
  if (text.length > maxBytes) text = text.slice(0, maxBytes);
  return contentType.includes("text/html") ? stripHtml(text) : text;
}
