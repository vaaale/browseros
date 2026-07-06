import "server-only";
import { emitNotification } from "../../notifications/store";
import type { IntegrationEvent } from "../../types";
import { readChatsCache } from "./user-cache";

// Notification dispatcher for the Telegram integration.
//
// Every "delivered to the OS" pathway (bot poller, webhook receiver, user
// MTProto update stream) routes through this module so mute settings are
// enforced in exactly one place. The module reads mute state from the chat
// cache (populated by `user_list_chats` and the mute/archive/pin methods) and
// short-circuits before ever calling emitNotification for muted chats.
//
// Bot-service notifications are ALSO subject to this filter — the user might
// mute a group chat where they receive both bot and user messages, and it's
// jarring to have one side silent and the other buzzing.

interface DispatchOpts {
  /** Bypass mute checks (used by test webhooks and explicit "route this" calls). */
  ignoreMute?: boolean;
}

function chatIdFromEvent(event: IntegrationEvent): string | undefined {
  const data = event.data ?? {};
  // Bot events: data.message.chat.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message: any = (data as any).message;
  if (message?.chat?.id != null) return String(message.chat.id);
  // Callback query events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cbq: any = (data as any).callbackQuery;
  if (cbq?.message?.chat?.id != null) return String(cbq.message.chat.id);
  // User service events use `chatId` in the payload directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatId = (data as any).chatId;
  if (chatId != null) return String(chatId);
  return undefined;
}

async function isChatMuted(chatId: string): Promise<boolean> {
  const cache = await readChatsCache();
  if (!cache) return false;
  const entry = cache.entries.find((c) => c.id === chatId);
  return Boolean(entry?.muted);
}

/**
 * Filter a batch of events, dropping any whose chat is muted. Used by the bot
 * poller / webhook receiver so muted events never reach the shared
 * notifications inbox in the first place.
 */
export async function filterMutedEvents(events: IntegrationEvent[]): Promise<IntegrationEvent[]> {
  if (events.length === 0) return events;
  const out: IntegrationEvent[] = [];
  for (const ev of events) {
    const chatId = chatIdFromEvent(ev);
    if (chatId && (await isChatMuted(chatId))) continue;
    out.push(ev);
  }
  return out;
}

/**
 * Emit an IntegrationEvent respecting per-chat mute settings. Returns the
 * assigned notification id, or null when the event was dropped due to mute.
 */
export async function dispatchTelegramEvent(
  event: IntegrationEvent,
  opts: DispatchOpts = {},
): Promise<number | null> {
  if (!opts.ignoreMute) {
    const chatId = chatIdFromEvent(event);
    if (chatId && (await isChatMuted(chatId))) return null;
  }
  return emitNotification(event);
}

/**
 * Batch variant. Preserves the input order and skips muted-chat events. Returns
 * the array of assigned ids (null entries where events were dropped).
 */
export async function dispatchTelegramEvents(
  events: IntegrationEvent[],
  opts: DispatchOpts = {},
): Promise<Array<number | null>> {
  const out: Array<number | null> = [];
  for (const ev of events) {
    out.push(await dispatchTelegramEvent(ev, opts));
  }
  return out;
}
