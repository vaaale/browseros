import "server-only";
import { complete } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { getSubAgent } from "@/lib/agent/subagents/store";
import { runClaudeAgent } from "@/lib/agent/subagents/claude-runner";

export interface GeneratedApp {
  name: string;
  html: string;
  source: "harness" | "local" | "template";
  note?: string;
}

const CODEGEN_PROMPT = (spec: string) =>
  `Build a single, self-contained index.html web app (all CSS and JS inline, no external dependencies or network calls) that implements:\n\n${spec}\n\nOutput the HTML directly as your final response — do NOT create or write any files. Return ONLY the HTML document, starting with <!doctype html>.`;

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

// Build via the Claude dev harness by delegating to the "developer" Claude
// sub-agent. Its generated subagent_type (its id, or an explicit one) drives
// the harness Agent tool — no hardcoded agent type.
async function tryHarness(spec: string): Promise<GeneratedApp | null> {
  const dev = await getSubAgent("developer");
  if (!dev || dev.type !== "claude") return null;
  const result = await runClaudeAgent(dev, CODEGEN_PROMPT(spec));
  if (result.error) return null;
  const html = extractHtml(result.output);
  return html ? { name: "", html, source: "harness", note: `via Claude agent "${dev.subagentType || dev.id}"` } : null;
}

async function tryLocal(spec: string): Promise<GeneratedApp | null> {
  if (!(await hasCredentials())) return null;
  try {
    const text = await complete({ prompt: CODEGEN_PROMPT(spec), maxTokens: 4096 });
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
