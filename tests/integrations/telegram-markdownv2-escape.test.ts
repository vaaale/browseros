// The auto-reply router's first MarkdownV2 pass blanket-escaped EVERY reserved
// character, which meant the agent's own formatting arrived literal: it was
// told to write *bold* and `code`, and the user saw "\*bold\*". The HTML
// interlude that replaced it traded that bug for trusting the agent to escape
// &, <, > itself.
//
// Fix under test: sendReply() is on parse_mode "MarkdownV2" and runs the text
// through sanitizeMarkdownV2(), which stashes well-formed formatting spans
// (*bold*, _italic_, `code`, ~strikethrough~, [label](url)) behind
// placeholders, escapes every remaining reserved character, then restores the
// spans — so the agent's formatting renders while stray punctuation ('-', '.',
// '!', an unpaired '*') can never make Telegram reject the message.
//
// Run: npm run test:unit -- tests/integrations/telegram-markdownv2-escape.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { _resetKeyCache } from "../../src/lib/integrations/secrets/keyfile";
import { getSecretsStore } from "../../src/lib/integrations/secrets/store";
import {
  escapeMarkdownV2,
  sanitizeMarkdownV2,
  sendReply,
} from "../../src/lib/integrations/services/telegram/agent-router";

const BOT_TOKEN = "12345:TEST_TOKEN_abcdefghijklmnopqrst";

/** Stub global fetch with a canned sendMessage response, capturing each call's
 *  parsed JSON body. No request leaves the process — the unit suite is hermetic. */
function stubTelegramApi(): {
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  restore: () => void;
} {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    if (method !== "sendMessage") throw new Error(`unexpected Telegram method: ${method}`);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function setup(label: string) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useTestDataDir is a test helper (temp-dir setup), not a React hook
  const { dir, cleanup } = useTestDataDir(label);
  _resetKeyCache();
  return {
    dir,
    dispose: () => {
      _resetKeyCache();
      cleanup();
    },
  };
}

async function sendAndCapture(text: string): Promise<{ text: string; parseMode: string }> {
  const api = stubTelegramApi();
  try {
    await sendReply(42, text);
  } finally {
    api.restore();
  }
  expect(api.calls).toHaveLength(1);
  expect(api.calls[0].method).toBe("sendMessage");
  return {
    text: api.calls[0].body.text as string,
    parseMode: api.calls[0].body.parse_mode as string,
  };
}

test.describe("escapeMarkdownV2", () => {
  test("escapes every MarkdownV2 special character", () => {
    // The full reserved set: * _ [ ] ( ) ~ > ` # + - . ! | / = { } plus the
    // backslash itself (a raw '\' would silently eat the character after it).
    const specials = "*_[]()~>`#+-.!|/={}\\";
    const escaped = escapeMarkdownV2(specials);
    expect(escaped).toBe(
      "\\*\\_\\[\\]\\(\\)\\~\\>\\`\\#\\+\\-\\.\\!\\|\\/\\=\\{\\}\\\\",
    );
  });

  test("leaves plain text untouched", () => {
    const plain = "Hello there, how are you today? 🚀 abcXYZ 0123";
    expect(escapeMarkdownV2(plain)).toBe(plain);
  });
});

test.describe("sanitizeMarkdownV2", () => {
  test("escapes reserved characters in plain text", () => {
    expect(sanitizeMarkdownV2("state-of-the-art (v2.0)!")).toBe(
      "state\\-of\\-the\\-art \\(v2\\.0\\)\\!",
    );
  });

  test("leaves plain text untouched", () => {
    const plain = "Hello there, how are you today? 🚀 abcXYZ 0123";
    expect(sanitizeMarkdownV2(plain)).toBe(plain);
  });

  test("preserves well-formed formatting spans", () => {
    const formatted = "*bold* then _italic_ then ~struck~ then `x = 1`";
    expect(sanitizeMarkdownV2(formatted)).toBe(formatted);
  });

  test("escapes reserved characters inside emphasis without breaking the markers", () => {
    // Telegram requires escaping inside entities too: *state-of-the-art!*
    // must go out as *state\-of\-the\-art\!* to render bold.
    expect(sanitizeMarkdownV2("*state-of-the-art!* _v2.0_")).toBe(
      "*state\\-of\\-the\\-art\\!* _v2\\.0_",
    );
  });

  test("preserves links, escaping the label but not the URL", () => {
    // Inside a link URL only ')' and '\' are reserved — an underscore or dot
    // there must stay raw or the link 404s.
    expect(sanitizeMarkdownV2("see [v2.0 notes](https://example.com/a_b.html) now")).toBe(
      "see [v2\\.0 notes](https://example.com/a_b.html) now",
    );
  });

  test("keeps inline code verbatim — its content is never formatted", () => {
    // '*', '_', '-' inside a code span are literal text to Telegram; escaping
    // or emphasising them would corrupt the snippet.
    const code = "run `rm -rf /tmp/*_cache_*` now!";
    expect(sanitizeMarkdownV2(code)).toBe("run `rm -rf /tmp/*_cache_*` now\\!");
  });

  test("escapes backslashes and backticks inside inline code", () => {
    // The only two characters MarkdownV2 reserves inside a code entity.
    expect(sanitizeMarkdownV2("`C:\\temp`")).toBe("`C:\\\\temp`");
  });

  test("escapes malformed markdown instead of sending it raw", () => {
    // An unpaired marker would make Telegram reject the whole message with
    // "can't parse entities" — it must be escaped down to literal text.
    expect(sanitizeMarkdownV2("2 * 3 = 6")).toBe("2 \\* 3 \\= 6");
    expect(sanitizeMarkdownV2("*oops")).toBe("\\*oops");
    expect(sanitizeMarkdownV2("[dangling](broken")).toBe("\\[dangling\\]\\(broken");
  });

  test("does not pair emphasis markers across lines", () => {
    expect(sanitizeMarkdownV2("*a\nb*")).toBe("\\*a\nb\\*");
  });
});

test.describe("Telegram agent-router — sendReply uses MarkdownV2 with sanitization", () => {
  test("sendReply sends parse_mode MarkdownV2", async () => {
    const { dispose } = setup("tg-mdv2-mode");
    try {
      await getSecretsStore().set("telegram", "bot_token", { token: BOT_TOKEN });
      const sent = await sendAndCapture("hello world");
      expect(sent.parseMode).toBe("MarkdownV2");
      expect(sent.text).toBe("hello world");
    } finally {
      dispose();
    }
  });

  test("sendReply escapes stray punctuation but preserves the agent's formatting", async () => {
    const { dispose } = setup("tg-mdv2-sanitize");
    try {
      await getSecretsStore().set("telegram", "bot_token", { token: BOT_TOKEN });
      // Unsanitized, the '-', '(', ')', '!' would make Telegram reject the
      // message; blanket-escaped, the *bold* and [link](url) would render as
      // literal asterisks and brackets. Sanitization must thread both needles.
      const risky = "state-of-the-art (v2.0)! *bold* [link](https://a.io)";
      const sent = await sendAndCapture(risky);
      expect(sent.parseMode).toBe("MarkdownV2");
      expect(sent.text).toBe(sanitizeMarkdownV2(risky));
      expect(sent.text).toBe(
        "state\\-of\\-the\\-art \\(v2\\.0\\)\\! *bold* [link](https://a.io)",
      );
    } finally {
      dispose();
    }
  });
});
