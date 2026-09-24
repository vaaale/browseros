import "server-only";
import { relative } from "node:path";
import type { AssistantTool, ToolContext, ToolExecuteResult } from "../../tools";
import type { Attachment } from "../../messages";
import { serverTool, schema, p } from "./util";
import { callBrowserTool, closeBrowserSession } from "@/lib/automation/browser-session";

// First-class browser driving tools (redesign of 004-browser-automation).
// Each tool proxies one @playwright/mcp tool through the STATEFUL session in
// browser-session.ts — one live browser per (conversation, agent), held open
// across calls, so navigate → click → screenshot all hit the same page.
// Gated by Settings → Browser Automation at execute time (like run_command):
// the tools are always registered; when disabled they answer with an
// actionable in-band error.

const GATE_NOTE = " Requires Settings → Browser Automation (off by default).";
const SESSION_NOTE =
  "Runs in your stateful browser session (one live browser per conversation): earlier navigation, clicks and login state are still there. ";

function sessionKey(ctx: ToolContext): string {
  return `${ctx.conversationId}:${ctx.agentId}`;
}

/** Attachments above this size are left on disk (the VFS path is still in the
 *  text) rather than inlined as a vision block — same ceiling as view_image. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Tools that change what the page shows. @playwright/mcp (0.0.76) answers
 *  these with only a LINK to a snapshot .yml it saved — useless to the model,
 *  which needs the element refs inline. The proxy follows up with a
 *  browser_snapshot call and appends its inline yaml, so every action ends
 *  with the resulting page state in the result (and no extra model turn). */
const FOLLOW_WITH_SNAPSHOT = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_hover",
  "browser_select_option",
  "browser_handle_dialog",
  "browser_wait_for",
  "browser_tabs",
]);

async function proxy(
  tool: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string | ToolExecuteResult> {
  const res = await callBrowserTool(sessionKey(ctx), tool, input);
  // The MCP server reports saved files by host path — sometimes absolute
  // (--output-dir), sometimes RELATIVE TO ITS CWD ("../../tmp/…/x.png"). The
  // user and the file_* tools speak VFS paths, so rewrite both spellings
  // (relative first: the relative form contains the absolute one as a suffix).
  const relHostDir = relative(process.cwd(), res.outputHostDir);
  let text = res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (relHostDir) text = text.split(relHostDir).join(res.outputVfsDir);
  text = text.split(res.outputHostDir).join(res.outputVfsDir);
  if (res.isError) throw new Error(text || "browser tool failed");

  if (FOLLOW_WITH_SNAPSHOT.has(tool)) {
    const snap = await callBrowserTool(sessionKey(ctx), "browser_snapshot", {});
    const snapText = snap.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    // A failed follow-up snapshot must not fail the action that succeeded.
    if (!snap.isError && snapText) text = `${text}\n\n${snapText}`;
  }

  // Screenshots (and any other image content) become vision blocks so the
  // model actually SEES the page — the old gateway path dropped these.
  const attachments: Attachment[] = res.content
    .filter((c) => c.type === "image" && typeof c.data === "string")
    .filter((c) => Buffer.byteLength(c.data as string, "base64") <= MAX_ATTACHMENT_BYTES)
    .map((c) => ({ type: "image", mimeType: c.mimeType ?? "image/png", data: c.data as string }));
  return attachments.length > 0 ? { text, attachments } : text;
}

// Schemas mirror @playwright/mcp's documented inputs (pinned dependency); the
// server validates for real — these exist so the model knows what to pass.
const el = {
  element: p.str("Human-readable description of the element (for logs/permission)"),
  target: p.str("Exact element reference from the latest browser_snapshot (e.g. \"e12\"), or a unique selector"),
};

export function browserTools(): Record<string, AssistantTool> {
  return {
    browser_navigate: serverTool(
      "browser_navigate",
      "Open a URL in your stateful browser session and return the page's accessibility snapshot (element refs you can click/type via the other browser_* tools). " +
        "Use this to DRIVE a real browser: scrape pages, operate web apps, or screenshot them." +
        GATE_NOTE,
      schema({ url: p.str("The URL to navigate to") }, ["url"]),
      (input, ctx) => proxy("browser_navigate", input, ctx),
    ),
    browser_navigate_back: serverTool(
      "browser_navigate_back",
      SESSION_NOTE + "Go back to the previous page in the history.",
      schema({}),
      (input, ctx) => proxy("browser_navigate_back", input, ctx),
    ),
    browser_snapshot: serverTool(
      "browser_snapshot",
      SESSION_NOTE +
        "Capture the current page's accessibility snapshot — the element refs (e.g. \"e12\") every other browser tool targets. Better than a screenshot for deciding what to click.",
      schema({
        target: p.str("Optional: snapshot only this element ref/selector"),
        depth: p.num("Optional: limit snapshot tree depth"),
      }),
      (input, ctx) => proxy("browser_snapshot", input, ctx),
    ),
    browser_click: serverTool(
      "browser_click",
      SESSION_NOTE + "Click an element (refs come from browser_navigate/browser_snapshot output).",
      schema(
        {
          ...el,
          doubleClick: p.bool("Double click instead of single"),
          button: p.str('Mouse button: "left" (default), "right", "middle"'),
        },
        ["target"],
      ),
      (input, ctx) => proxy("browser_click", input, ctx),
    ),
    browser_type: serverTool(
      "browser_type",
      SESSION_NOTE + "Type text into an editable element.",
      schema(
        {
          ...el,
          text: p.str("Text to type into the element"),
          submit: p.bool("Press Enter after typing"),
          slowly: p.bool("Type one character at a time (for pages with key handlers)"),
        },
        ["target", "text"],
      ),
      (input, ctx) => proxy("browser_type", input, ctx),
    ),
    browser_fill_form: serverTool(
      "browser_fill_form",
      SESSION_NOTE + "Fill multiple form fields in one call.",
      schema(
        {
          fields: {
            type: "array",
            description: "Fields to fill",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Human-readable field name" },
                type: { type: "string", description: "Field type: textbox | checkbox | radio | combobox | slider" },
                ref: { type: "string", description: "Element ref from the page snapshot" },
                value: { type: "string", description: "Value to fill (for checkbox/radio: \"true\"/\"false\")" },
              },
              required: ["name", "type", "ref", "value"],
            },
          },
        },
        ["fields"],
      ),
      (input, ctx) => proxy("browser_fill_form", input, ctx),
    ),
    browser_press_key: serverTool(
      "browser_press_key",
      SESSION_NOTE + "Press a keyboard key (e.g. \"ArrowLeft\", \"Enter\", \"a\").",
      schema({ key: p.str("Key name or character to generate") }, ["key"]),
      (input, ctx) => proxy("browser_press_key", input, ctx),
    ),
    browser_hover: serverTool(
      "browser_hover",
      SESSION_NOTE + "Hover the mouse over an element.",
      schema({ ...el }, ["target"]),
      (input, ctx) => proxy("browser_hover", input, ctx),
    ),
    browser_select_option: serverTool(
      "browser_select_option",
      SESSION_NOTE + "Select option(s) in a dropdown.",
      schema(
        {
          ...el,
          values: p.strArr("Value(s) to select"),
        },
        ["target", "values"],
      ),
      (input, ctx) => proxy("browser_select_option", input, ctx),
    ),
    browser_handle_dialog: serverTool(
      "browser_handle_dialog",
      SESSION_NOTE + "Accept or dismiss the currently open dialog (alert/confirm/prompt).",
      schema(
        {
          accept: p.bool("Whether to accept the dialog"),
          promptText: p.str("Text to enter, for prompt dialogs"),
        },
        ["accept"],
      ),
      (input, ctx) => proxy("browser_handle_dialog", input, ctx),
    ),
    browser_wait_for: serverTool(
      "browser_wait_for",
      SESSION_NOTE + "Wait for text to appear/disappear or for a fixed time.",
      schema({
        time: p.num("Seconds to wait"),
        text: p.str("Wait until this text appears"),
        textGone: p.str("Wait until this text disappears"),
      }),
      (input, ctx) => proxy("browser_wait_for", input, ctx),
    ),
    browser_evaluate: serverTool(
      "browser_evaluate",
      SESSION_NOTE +
        "Evaluate a JavaScript function on the page (or on an element) and return its result — useful for extracting structured data when scraping.",
      schema(
        {
          function: p.str("() => { /* code */ } or (element) => { /* code */ } when target is provided"),
          ...el,
        },
        ["function"],
      ),
      (input, ctx) => proxy("browser_evaluate", input, ctx),
    ),
    browser_take_screenshot: serverTool(
      "browser_take_screenshot",
      SESSION_NOTE +
        "Screenshot the current page (or one element). The image is saved into the user's Files under /Screenshots AND returned to you as a vision block so you can see it. For deciding what to click, prefer browser_snapshot.",
      schema({
        filename: p.str("Optional file name (relative, saved under /Screenshots). Defaults to page-{timestamp}.png"),
        fullPage: p.bool("Capture the full scrollable page instead of the viewport"),
        type: p.str('Image format: "png" (default) or "jpeg"'),
        ...el,
      }),
      (input, ctx) => proxy("browser_take_screenshot", input, ctx),
    ),
    browser_console_messages: serverTool(
      "browser_console_messages",
      SESSION_NOTE + "Return the page's console messages (errors and warnings included).",
      schema({
        level: p.str('Minimum level: "error" | "warning" | "info" (default) | "debug"'),
        all: p.bool("Include messages since session start, not just since last navigation"),
      }),
      (input, ctx) => proxy("browser_console_messages", input, ctx),
    ),
    browser_resize: serverTool(
      "browser_resize",
      SESSION_NOTE + "Resize the browser viewport (e.g. before screenshots for documentation).",
      schema({ width: p.num("Viewport width"), height: p.num("Viewport height") }, ["width", "height"]),
      (input, ctx) => proxy("browser_resize", input, ctx),
    ),
    browser_tabs: serverTool(
      "browser_tabs",
      SESSION_NOTE + "List, create, close, or select a browser tab.",
      schema(
        {
          action: p.str('One of "list", "new", "close", "select"'),
          index: p.num("Tab index for close/select"),
          url: p.str("URL to open, for new"),
        },
        ["action"],
      ),
      (input, ctx) => proxy("browser_tabs", input, ctx),
    ),
    browser_close: serverTool(
      "browser_close",
      "End your browser session: closes the browser and frees its resources. Do this when you are done driving the browser." + GATE_NOTE,
      schema({}),
      async (_input, ctx) => {
        // Ends the SESSION (kills the browser process), not just the current
        // page — the whole point of the tool is deterministic teardown.
        const closed = await closeBrowserSession(sessionKey(ctx));
        return closed ? "Browser session closed." : "No browser session was open.";
      },
    ),
  };
}
