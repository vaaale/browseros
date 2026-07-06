import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError, IntegrationError } from "../../../errors";
import type { AdapterMethodMeta } from "../../../actions/types";
import type { ServiceDefinition } from "../../../types";
import { registerAdapter, getAdapterEntry as _getAdapterEntry } from "../../../actions/adapter-registry";
import { TELEGRAM_USER_METHOD_DESCRIPTORS, type UserMethodName } from "./user-methods";
import { TELEGRAM_USER_SCOPES } from "../manifest";
import { withClient, type MtprotoClient } from "../mtproto-client";
import {
  readContactsCache,
  writeContactsCache,
  readChatsCache,
  writeChatsCache,
  isFresh,
  type CachedContact,
  type CachedChat,
} from "../user-cache";
import { indexMessages, searchMessages, type IndexedMessage } from "../search-index";
import { setArchiveState, setMuteState, setPinState } from "../chat-management";

// Full-featured MTProto user adapter. Implements the same
// scope-guard/return-plain-JSON contract as the bot adapter so the LLM sees a
// consistent surface (`telegram_user_send_message`, `telegram_user_list_chats`,
// etc). Every method:
//   1. Guards on the appropriate telegram:user.* scope.
//   2. Opens a short-lived MTProto client (via `withClient`) and closes it
//      before returning — we do NOT keep a long-lived connection so serverless
//      request lifecycles behave.
//   3. Normalises gramjs's wire objects (which carry BigInt ids, TL type tags,
//      etc.) into plain JSON that CopilotKit / the UI can consume unchanged.

function serviceDef(): ServiceDefinition {
  const svc = getService("telegram", "user");
  if (!svc) {
    throw new IntegrationConfigError("Telegram user service is not registered.", {
      integrationId: "telegram",
    });
  }
  return svc;
}

function toIdString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  // gramjs BigInt-ish objects: { value: bigint }
  if (typeof v === "object" && v !== null && "value" in (v as Record<string, unknown>)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (v as any).value;
    if (typeof inner === "bigint" || typeof inner === "number" || typeof inner === "string") {
      return String(inner);
    }
  }
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

function statusLabel(status: unknown): string | undefined {
  if (!status || typeof status !== "object") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const st: any = status;
  const cls = st.className ?? st.constructor?.name ?? "";
  if (cls === "UserStatusOnline") return "online";
  if (cls === "UserStatusOffline" && typeof st.wasOnline === "number") {
    return `lastSeen:${st.wasOnline}`;
  }
  if (cls === "UserStatusRecently") return "recently";
  if (cls === "UserStatusLastWeek") return "lastWeek";
  if (cls === "UserStatusLastMonth") return "lastMonth";
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normaliseContact(raw: any): CachedContact | null {
  if (!raw) return null;
  const id = toIdString(raw.id);
  if (!id) return null;
  return {
    id,
    username: raw.username ?? undefined,
    firstName: raw.firstName ?? raw.first_name ?? undefined,
    lastName: raw.lastName ?? raw.last_name ?? undefined,
    phone: raw.phone ?? undefined,
    isBot: raw.bot === true,
    status: statusLabel(raw.status),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normaliseChat(dialog: any): CachedChat | null {
  if (!dialog) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entity: any = dialog.entity ?? dialog;
  const id = toIdString(entity?.id ?? dialog?.id);
  if (!id) return null;
  const cls = entity?.className ?? entity?.constructor?.name ?? "";
  const type: CachedChat["type"] =
    cls === "User" ? "user" : cls === "Channel" ? "channel" : cls === "Chat" ? "chat" : "unknown";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastMsg: any = dialog.message ?? dialog.lastMessage ?? undefined;
  return {
    id,
    type,
    title:
      entity?.title ??
      ([entity?.firstName ?? entity?.first_name, entity?.lastName ?? entity?.last_name]
        .filter(Boolean)
        .join(" ") ||
        undefined),
    username: entity?.username ?? undefined,
    unreadCount: typeof dialog.unreadCount === "number" ? dialog.unreadCount : undefined,
    lastMessage: lastMsg
      ? {
          text: lastMsg.message ?? lastMsg.text ?? undefined,
          date: typeof lastMsg.date === "number" ? lastMsg.date : undefined,
          fromId: lastMsg.fromId ? toIdString(lastMsg.fromId) : undefined,
        }
      : undefined,
    pinned: dialog.pinned === true,
    archived: dialog.archived === true || dialog.folderId === 1,
    // Mute detection lives in dialog.notifySettings.muteUntil; treat future
    // epoch as muted.
    muted:
      typeof dialog.notifySettings?.muteUntil === "number" &&
      dialog.notifySettings.muteUntil > Math.floor(Date.now() / 1000),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normaliseMessage(raw: any, chatId: string): IndexedMessage | null {
  if (!raw || typeof raw.id !== "number") return null;
  const text: string = raw.message ?? raw.text ?? "";
  // Media summary — flexsearch doesn't index this, but the store keeps it.
  let media: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = raw.media;
  if (m) {
    const kind = m.className ?? m.constructor?.name ?? "media";
    media = String(kind);
  }
  const senderId = raw.fromId ? toIdString(raw.fromId) : undefined;
  return {
    id: `${chatId}:${raw.id}`,
    chatId,
    messageId: raw.id,
    text,
    date: typeof raw.date === "number" ? raw.date : Math.floor(Date.now() / 1000),
    senderId,
    media,
  };
}

// --- Adapter ---------------------------------------------------------------

export class TelegramUserAdapter extends ServiceAdapter {
  constructor() {
    super("telegram", serviceDef());
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
  }): Promise<{ chatId: string; messageId: number; date: number }> {
    return this.withScope(TELEGRAM_USER_SCOPES.send, async () => {
      return withClient(async (client: MtprotoClient) => {
        const peer = input.chatId === "me" ? "me" : input.chatId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await client.sendMessage(peer, {
          message: input.text,
          replyTo: input.replyToMessageId,
        });
        return {
          chatId: input.chatId,
          messageId: typeof res?.id === "number" ? res.id : 0,
          date: typeof res?.date === "number" ? res.date : Math.floor(Date.now() / 1000),
        };
      });
    });
  }

  async listContacts(refresh = false): Promise<{ contacts: CachedContact[]; cached: boolean; fetchedAt: number }> {
    return this.withScope(TELEGRAM_USER_SCOPES.read, async () => {
      const cache = await readContactsCache();
      if (!refresh && isFresh(cache)) {
        return { contacts: cache!.entries, cached: true, fetchedAt: cache!.fetchedAt };
      }
      const contacts = await withClient(async (client: MtprotoClient) => {
        // Import Api lazily to keep the module graph acyclic.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { Api } = (await import(/* turbopackIgnore: true */ "telegram")) as { Api: any };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await client.invoke(new Api.contacts.GetContacts({ hash: 0 }));
        const out: CachedContact[] = [];
        for (const u of res.users ?? []) {
          const n = normaliseContact(u);
          if (n) out.push(n);
        }
        return out;
      });
      await writeContactsCache(contacts);
      return { contacts, cached: false, fetchedAt: Date.now() };
    });
  }

  async listChats(opts: { refresh?: boolean; archived?: boolean; limit?: number } = {}): Promise<{
    chats: CachedChat[];
    cached: boolean;
    fetchedAt: number;
  }> {
    return this.withScope(TELEGRAM_USER_SCOPES.read, async () => {
      const cache = await readChatsCache();
      const filter = (c: CachedChat) => (opts.archived ? c.archived === true : c.archived !== true);
      if (!opts.refresh && isFresh(cache)) {
        return {
          chats: (cache!.entries.filter(filter)).slice(0, Math.min(opts.limit ?? 500, 500)),
          cached: true,
          fetchedAt: cache!.fetchedAt,
        };
      }
      const chats = await withClient(async (client: MtprotoClient) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dialogs: any[] = await client.getDialogs({
          limit: Math.max(1, Math.min(500, opts.limit ?? 200)),
          archived: opts.archived === true,
        });
        const out: CachedChat[] = [];
        for (const d of dialogs) {
          const n = normaliseChat(d);
          if (n) out.push(n);
        }
        return out;
      });
      await writeChatsCache(chats);
      return {
        chats: chats.filter(filter),
        cached: false,
        fetchedAt: Date.now(),
      };
    });
  }

  async getChatHistory(input: {
    chatId: string;
    limit?: number;
    offsetId?: number;
  }): Promise<{ chatId: string; messages: IndexedMessage[]; indexed: number }> {
    return this.withScope(TELEGRAM_USER_SCOPES.read, async () => {
      const limit = Math.max(1, Math.min(100, input.limit ?? 50));
      const messages = await withClient(async (client: MtprotoClient) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw: any[] = await client.getMessages(input.chatId, {
          limit,
          offsetId: input.offsetId,
        });
        const out: IndexedMessage[] = [];
        for (const m of raw) {
          const n = normaliseMessage(m, input.chatId);
          if (n) out.push(n);
        }
        return out;
      });
      const { added } = await indexMessages(messages);
      return { chatId: input.chatId, messages, indexed: added };
    });
  }

  async searchMessages(input: {
    query: string;
    chatId?: string;
    senderId?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<{ query: string; results: IndexedMessage[] }> {
    return this.withScope(TELEGRAM_USER_SCOPES.read, async () => {
      if (!input.query || input.query.trim().length === 0) {
        throw new IntegrationConfigError("`query` is required.", { integrationId: "telegram" });
      }
      const results = await searchMessages(input.query, {
        chatId: input.chatId,
        senderId: input.senderId,
        since: input.since,
        until: input.until,
        limit: input.limit,
      });
      return { query: input.query, results };
    });
  }

  async muteChat(input: { chatId: string; hours?: number }): Promise<{ chatId: string; muted: boolean; muteUntil: number }> {
    return this.withScope(TELEGRAM_USER_SCOPES.send, async () => {
      // 0x7FFFFFFF ≈ 2038-01-19 — Telegram's "mute forever" sentinel.
      const foreverEpoch = 0x7fffffff;
      const nowSec = Math.floor(Date.now() / 1000);
      const muteUntilEpoch =
        !input.hours || input.hours <= 0 ? foreverEpoch : nowSec + Math.floor(input.hours * 3600);
      return setMuteState({ chatId: input.chatId, muteUntilEpoch });
    });
  }

  async unmuteChat(input: { chatId: string }): Promise<{ chatId: string; muted: boolean; muteUntil: number }> {
    return this.withScope(TELEGRAM_USER_SCOPES.send, async () => {
      return setMuteState({ chatId: input.chatId, muteUntilEpoch: 0 });
    });
  }

  async archiveChat(input: { chatId: string }): Promise<{ chatId: string; archived: boolean }> {
    return this.withScope(TELEGRAM_USER_SCOPES.send, async () => {
      return setArchiveState({ chatId: input.chatId, archive: true });
    });
  }

  async unarchiveChat(input: { chatId: string }): Promise<{ chatId: string; archived: boolean }> {
    return this.withScope(TELEGRAM_USER_SCOPES.send, async () => {
      return setArchiveState({ chatId: input.chatId, archive: false });
    });
  }

  async pinChat(input: { chatId: string }): Promise<{ chatId: string; pinned: boolean }> {
    return this.withScope(TELEGRAM_USER_SCOPES.send, async () => {
      return setPinState({ chatId: input.chatId, pinned: true });
    });
  }

  async unpinChat(input: { chatId: string }): Promise<{ chatId: string; pinned: boolean }> {
    return this.withScope(TELEGRAM_USER_SCOPES.send, async () => {
      return setPinState({ chatId: input.chatId, pinned: false });
    });
  }
}

// Guard so the IntegrationError import doesn't get pruned as unused when this
// file is compiled in isolation — the runtime path uses it via
// mtproto-client's throw chain.
void IntegrationError;

const INVOKERS: Record<
  UserMethodName,
  (adapter: TelegramUserAdapter, args: Record<string, unknown>) => Promise<unknown>
> = {
  user_send_message: (a, args) =>
    a.sendMessage({
      chatId: String(args.chatId),
      text: String(args.text),
      replyToMessageId: args.replyToMessageId as number | undefined,
    }),
  user_list_contacts: (a, args) => a.listContacts(args.refresh === true),
  user_list_chats: (a, args) =>
    a.listChats({
      refresh: args.refresh === true,
      archived: args.archived === true,
      limit: args.limit as number | undefined,
    }),
  user_get_chat_history: (a, args) =>
    a.getChatHistory({
      chatId: String(args.chatId),
      limit: args.limit as number | undefined,
      offsetId: args.offsetId as number | undefined,
    }),
  user_search_messages: (a, args) =>
    a.searchMessages({
      query: String(args.query),
      chatId: args.chatId as string | undefined,
      senderId: args.senderId as string | undefined,
      since: args.since as number | undefined,
      until: args.until as number | undefined,
      limit: args.limit as number | undefined,
    }),
  user_mute_chat: (a, args) =>
    a.muteChat({
      chatId: String(args.chatId),
      hours: args.hours as number | undefined,
    }),
  user_unmute_chat: (a, args) => a.unmuteChat({ chatId: String(args.chatId) }),
  user_archive_chat: (a, args) => a.archiveChat({ chatId: String(args.chatId) }),
  user_unarchive_chat: (a, args) => a.unarchiveChat({ chatId: String(args.chatId) }),
  user_pin_chat: (a, args) => a.pinChat({ chatId: String(args.chatId) }),
  user_unpin_chat: (a, args) => a.unpinChat({ chatId: String(args.chatId) }),
};

export const TELEGRAM_USER_METHODS: readonly AdapterMethodMeta<TelegramUserAdapter>[] =
  TELEGRAM_USER_METHOD_DESCRIPTORS.map((d) => ({
    method: d.method,
    scope: d.scope,
    description: d.description,
    parameters: d.parameters,
    invoke: INVOKERS[d.method],
  }));

if (!_getAdapterEntry("telegram", "user")) {
  registerAdapter("telegram", "user", {
    createAdapter: () => new TelegramUserAdapter(),
    methods: TELEGRAM_USER_METHODS,
    // MTProto pushes updates over a persistent socket rather than
    // scheduler-poll. Leaving capabilities empty for Phase 2 — a follow-up
    // could add poll:true wired to a `getState`/`getDifference` diff loop.
    capabilities: {},
  });
}
