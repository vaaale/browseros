import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL } from "@/lib/agent/config";
import { createBosMcpClient } from "@/lib/mcp/client";

export interface GeneratedApp {
  name: string;
  html: string;
  source: "harness" | "local" | "template";
  note?: string;
}

const HARNESS_URL = process.env.BOS_DEV_HARNESS_URL || "http://wingman.akhbar.home:7272/mcp";

const CODEGEN_PROMPT = (spec: string) =>
  `Build a single, self-contained index.html web app (all CSS and JS inline, no external dependencies or network calls) that implements:\n\n${spec}\n\nReturn ONLY the HTML document, starting with <!doctype html>.`;

function extractHtml(text: string): string | null {
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) {
    // Maybe fenced code block.
    const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (fence && /<\w+/.test(fence[1])) return fence[1].trim();
    return null;
  }
  const end = text.lastIndexOf("</html>");
  return end === -1 ? text.slice(start) : text.slice(start, end + 7);
}

// Best-effort: pick a likely text-generation tool from an unknown MCP server and
// fill its most probable text parameter with our prompt.
async function tryHarness(spec: string): Promise<GeneratedApp | null> {
  const client = await createBosMcpClient({ name: "dev-harness", endpoint: HARNESS_URL });
  try {
    const tools = await client.tools();
    const names = Object.keys(tools);
    if (names.length === 0) return null;
    const pick =
      names.find((n) => /generate|code|complete|prompt|chat|message|ask|claude|sample/i.test(n)) ?? names[0];
    const tool = tools[pick];
    const props = tool.schema?.parameters?.properties ?? {};
    const textKey =
      Object.keys(props).find((k) => /prompt|message|input|query|text|content|task/i.test(k)) ?? "prompt";
    const args: Record<string, unknown> = { [textKey]: CODEGEN_PROMPT(spec) };
    const result = await tool.execute(args);
    const html = extractHtml(typeof result === "string" ? result : JSON.stringify(result));
    return html ? { name: "", html, source: "harness", note: `via MCP tool "${pick}"` } : null;
  } catch {
    return null;
  } finally {
    await client.close?.().catch(() => {});
  }
}

async function tryLocal(spec: string): Promise<GeneratedApp | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await new Anthropic().messages.create({
      model: AGENT_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: CODEGEN_PROMPT(spec) }],
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const html = extractHtml(text);
    return html ? { name: "", html, source: "local" } : null;
  } catch {
    return null;
  }
}

function template(spec: string): GeneratedApp {
  const safe = spec.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BrowserOS App</title>
<style>
  body { margin:0; font-family: system-ui, sans-serif; background:#0f1117; color:#e7e9ee; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 18px; }
  .spec { background:#1a1d27; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:16px; white-space:pre-wrap; }
  button { margin-top:16px; background:#5b8cff; color:#fff; border:0; padding:8px 14px; border-radius:8px; cursor:pointer; }
  .files { margin-top:16px; font-size:13px; color:#9aa0ad; }
</style>
</head>
<body>
<main>
  <h1>App scaffold</h1>
  <p>This app was scaffolded by the BrowserOS dev studio. Spec:</p>
  <div class="spec">${safe}</div>
  <button id="b">It works — click me</button>
  <p id="out"></p>
  <div class="files" id="files">Reading your files…</div>
</main>
<script>
  document.getElementById('b').onclick = () => {
    document.getElementById('out').textContent = 'Hello from your installed app at ' + new Date().toLocaleTimeString();
  };
  // Demonstrates the OS API available to installed apps (same-origin fetch).
  fetch('/api/fs?op=list&path=/').then(r=>r.json()).then(d=>{
    document.getElementById('files').textContent = 'VFS root: ' + (d.entries||[]).map(e=>e.name).join(', ');
  }).catch(()=>{ document.getElementById('files').textContent=''; });
</script>
</body>
</html>`;
  return { name: "", html, source: "template", note: "Harness and local model unavailable; scaffolded a starter app." };
}

/** Generate an app from a natural-language spec using the best available backend. */
export async function generateApp(spec: string): Promise<GeneratedApp> {
  return (await tryHarness(spec)) ?? (await tryLocal(spec)) ?? template(spec);
}
