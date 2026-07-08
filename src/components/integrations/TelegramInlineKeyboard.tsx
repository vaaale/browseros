"use client";

import { useCallback, useState } from "react";
import { ExternalLink } from "lucide-react";

// TelegramInlineKeyboard — renders a Bot API `reply_markup.inline_keyboard`
// as an accessible grid of buttons.
//
// Telegram inline keyboards are a 2D array of buttons. Each button is one of:
//   - text-only callback: { text, callback_data }
//   - URL link:           { text, url }
//   - switch inline:      { text, switch_inline_query* } (handled as info-only)
//   - webapp / login:     minimally handled — we render as a link with a hint
//
// Callback buttons dispatch to a caller-provided `onCallback(data, buttonText)`
// which typically posts to the Bot API's answerCallbackQuery endpoint (via the
// existing bot_answer_callback tool).

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  switch_inline_query?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  switch_inline_query_current_chat?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  web_app?: { url: string };
  login_url?: { url: string; forward_text?: string };
}

export type InlineKeyboard = InlineKeyboardButton[][];

export interface TelegramInlineKeyboardProps {
  keyboard: InlineKeyboard;
  /**
   * Invoked when the user clicks a callback-data button. Should ultimately
   * translate to a `bot_answer_callback` action (Telegram requires it within
   * ~10 s). Return a promise so we can show a "sending…" state.
   */
  onCallback?: (data: string, buttonText: string) => Promise<void> | void;
  /** Optional class overrides on the wrapping container. */
  className?: string;
  /** Disable every button (e.g. keyboard from a deleted message). */
  disabled?: boolean;
}

function classify(btn: InlineKeyboardButton): "url" | "callback" | "webapp" | "switch" | "unknown" {
  if (btn.url) return "url";
  if (btn.callback_data != null) return "callback";
  if (btn.web_app?.url) return "webapp";
  if (btn.switch_inline_query != null || btn.switch_inline_query_current_chat != null) return "switch";
  return "unknown";
}

export function TelegramInlineKeyboard({
  keyboard,
  onCallback,
  className,
  disabled,
}: TelegramInlineKeyboardProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  const handleCallback = useCallback(
    async (btn: InlineKeyboardButton, rowIdx: number, colIdx: number) => {
      if (!btn.callback_data || !onCallback) return;
      const key = `${rowIdx}:${colIdx}`;
      setPending(key);
      setError(undefined);
      try {
        await onCallback(btn.callback_data, btn.text);
      } catch (e) {
        setError((e as Error).message ?? "Callback failed");
      } finally {
        setPending((v) => (v === key ? null : v));
      }
    },
    [onCallback],
  );

  if (!Array.isArray(keyboard) || keyboard.length === 0) return null;

  return (
    <div
      className={`space-y-1 ${className ?? ""}`}
      role="group"
      aria-label="Telegram inline keyboard"
    >
      {keyboard.map((row, rowIdx) => (
        <div key={rowIdx} className="flex flex-wrap gap-1.5">
          {row.map((btn, colIdx) => {
            const kind = classify(btn);
            const key = `${rowIdx}:${colIdx}`;
            const isPending = pending === key;
            const commonClass =
              "inline-flex min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-white/15 bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-white/85 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40";
            if (kind === "url" && btn.url) {
              return (
                <a
                  key={key}
                  href={btn.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={commonClass}
                >
                  <span className="truncate">{btn.text}</span>
                  <ExternalLink size={10} className="opacity-60" />
                </a>
              );
            }
            if (kind === "webapp" && btn.web_app?.url) {
              return (
                <a
                  key={key}
                  href={btn.web_app.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={commonClass}
                  title="Opens a Telegram Web App in a new tab."
                >
                  <span className="truncate">{btn.text}</span>
                  <ExternalLink size={10} className="opacity-60" />
                </a>
              );
            }
            if (kind === "callback") {
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled || isPending}
                  onClick={() => void handleCallback(btn, rowIdx, colIdx)}
                  className={commonClass}
                  aria-label={`Send callback: ${btn.text}`}
                >
                  <span className="truncate">{btn.text}</span>
                  {isPending && (
                    <span className="ml-1 h-3 w-3 animate-spin rounded-full border border-white/40 border-t-transparent" />
                  )}
                </button>
              );
            }
            // Switch inline query, login_url, unknown types — render as an
            // informational chip so the user still sees the label but knows
            // it's not actionable from here.
            return (
              <span
                key={key}
                className="inline-flex min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-dashed border-white/15 bg-white/[0.03] px-3 py-1.5 text-[12px] text-white/50"
                title={`Unsupported button type: ${kind}. Handle via the Telegram app.`}
              >
                <span className="truncate">{btn.text}</span>
              </span>
            );
          })}
        </div>
      ))}
      {error && (
        <p className="mt-1 text-[11px] text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default TelegramInlineKeyboard;
