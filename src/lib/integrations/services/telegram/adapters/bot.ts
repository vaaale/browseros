import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError, IntegrationError, IntegrationScopeError } from "../../../errors";
import type { AdapterMethodMeta } from "../../../actions/types";
import type { IntegrationEvent, ServiceDefinition } from "../../../types";
import { requireBotToken } from "../auth";
import { telegramFetch, telegramFetchMultipart } from "../client";
import { enqueue } from "../queue";
import { flushQueueOnce } from "../poller";
import { TELEGRAM_BOT_SCOPES } from "../manifest";
import { TELEGRAM_BOT_METHOD_DESCRIPTORS, type BotMethodName } from "./bot-methods";
import { readBuffer as vfsReadBuffer } from "@/os/vfs";
import { registerAdapter, getAdapterEntry as _getAdapterEntry } from "../../../actions/adapter-registry";

// TelegramBotAdapter — one method per Bot API surface we expose. Every method:
//   1. Guards via `withScope(<telegram:bot.*>)` (base class handles denial).
//   2. Loads the bot token from SecretsStore (via `requireBotToken`).
//   3. Delegates to `telegramFetch` / `telegramFetchMultipart` (which enforce
//      retry_after + retry logic).
//   4. On a transient network failure with a send method, enqueues the payload
//      into the offline queue so the worker can retry later.
//
// Method metadata lives in `TELEGRAM_BOT_METHODS` at the bottom of the file.

// --- Types ----------------------------------------------------------------

export interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: TelegramMessage;
    data?: string;
  };
}

export interface SendMessageInput {
  chatId: string | number;
  text: string;
  parseMode?: "MarkdownV2" | "HTML" | "";
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  replyToMessageId?: number;
}

export interface SendMediaInput {
  chatId: string | number;
  url?: string;
  fileId?: string;
  path?: string;
  caption?: string;
  parseMode?: "MarkdownV2" | "HTML" | "";
  replyToMessageId?: number;
}

export interface ReplyInput {
  chatId: string | number;
  messageId: number;
  text: string;
  parseMode?: "MarkdownV2" | "HTML" | "";
}

export interface ForwardInput {
  toChatId: string | number;
  fromChatId: string | number;
  messageId: number;
  disableNotification?: boolean;
}

export interface EditInput {
  chatId: string | number;
  messageId: number;
  text: string;
  parseMode?: "MarkdownV2" | "HTML" | "";
  disableWebPagePreview?: boolean;
}

export interface DeleteInput {
  chatId: string | number;
  messageId: number;
}

export interface PinInput {
  chatId: string | number;
  messageId: number;
  disableNotification?: boolean;
}

export interface UnpinInput {
  chatId: string | number;
  messageId?: number;
}

export interface AnswerCallbackInput {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface GetUpdatesInput {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowedUpdates?: string[];
}

export interface PollOnceResult {
  newMessages: number;
  events: IntegrationEvent[];
}

// --- Helpers --------------------------------------------------------------

function serviceDef(): ServiceDefinition {
  const svc = getService("telegram", "bot");
  if (!svc) {
    throw new IntegrationConfigError(
      "Telegram bot service is not registered.",
      { integrationId: "telegram" },
    );
  }
  return svc;
}

/** True for network/5xx errors the queue can retry; false for permanent ones. */
function isTransientError(err: unknown): boolean {
  if (err instanceof IntegrationScopeError) return false;
  if (err instanceof IntegrationError) {
    // 4xx from Telegram (invalid chat id, wrong parse mode) are permanent.
    if (err.code.startsWith("telegram_api_error_4")) return false;
    return true;
  }
  return true;
}

function truthyPath(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

// Load a file for multipart upload. Accepts a BOS VFS path
// (starts with "/") or an absolute filesystem path. Returns { data, filename }.
async function readForUpload(pathish: string): Promise<{ data: Buffer; filename: string }> {
  if (pathish.startsWith("/") && !pathish.startsWith("/home/") && !pathish.startsWith("/tmp/") && !pathish.startsWith("/var/")) {
    // Treat as VFS path.
    const data = await vfsReadBuffer(pathish);
    return { data, filename: path.basename(pathish) };
  }
  // Absolute host path.
  const data = await fs.readFile(pathish);
  return { data, filename: path.basename(pathish) };
}

// --- Adapter --------------------------------------------------------------

export class TelegramBotAdapter extends ServiceAdapter {
  constructor() {
    super("telegram", serviceDef());
  }

  private async defaultParseMode(): Promise<"MarkdownV2" | "HTML" | ""> {
    const state = await this.getState();
    const cfg = state.services["bot"]?.config ?? {};
    const mode = (cfg.defaultParseMode as string | undefined) ?? "MarkdownV2";
    if (mode === "MarkdownV2" || mode === "HTML" || mode === "") return mode;
    return "MarkdownV2";
  }

  async getMe(): Promise<BotInfo> {
    return this.withScope(TELEGRAM_BOT_SCOPES.read, async () => {
      const token = await requireBotToken();
      return telegramFetch<BotInfo>(token, "getMe");
    });
  }

  async sendMessage(input: SendMessageInput): Promise<TelegramMessage> {
    return this.withScope(TELEGRAM_BOT_SCOPES.send, async () => {
      const token = await requireBotToken();
      const parseMode = input.parseMode ?? (await this.defaultParseMode());
      const body: Record<string, unknown> = {
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: input.disableWebPagePreview ?? false,
        disable_notification: input.disableNotification ?? false,
      };
      if (parseMode) body.parse_mode = parseMode;
      if (typeof input.replyToMessageId === "number") body.reply_to_message_id = input.replyToMessageId;
      try {
        return await telegramFetch<TelegramMessage>(token, "sendMessage", body);
      } catch (err) {
        if (isTransientError(err)) {
          await enqueue({ method: "sendMessage", payload: body, error: (err as Error).message });
        }
        throw err;
      }
    });
  }

  async sendPhoto(input: SendMediaInput): Promise<TelegramMessage> {
    return this.withScope(TELEGRAM_BOT_SCOPES.send, async () => {
      const token = await requireBotToken();
      const parseMode = input.parseMode ?? (await this.defaultParseMode());
      const filePath = truthyPath(input.path);
      // URL / fileId path — JSON body, no upload needed.
      if (!filePath) {
        const source = input.url ?? input.fileId;
        if (!source) {
          throw new IntegrationConfigError(
            "messages_send_photo requires exactly one of: url, fileId, path.",
            { integrationId: "telegram" },
          );
        }
        const body: Record<string, unknown> = {
          chat_id: input.chatId,
          photo: source,
        };
        if (input.caption) body.caption = input.caption;
        if (parseMode) body.parse_mode = parseMode;
        if (typeof input.replyToMessageId === "number") body.reply_to_message_id = input.replyToMessageId;
        try {
          return await telegramFetch<TelegramMessage>(token, "sendPhoto", body);
        } catch (err) {
          if (isTransientError(err)) {
            await enqueue({ method: "sendPhoto", payload: body, error: (err as Error).message });
          }
          throw err;
        }
      }
      // Multipart upload.
      const { data, filename } = await readForUpload(filePath);
      const form = new FormData();
      form.set("chat_id", String(input.chatId));
      form.set("photo", new Blob([new Uint8Array(data)]), filename);
      if (input.caption) form.set("caption", input.caption);
      if (parseMode) form.set("parse_mode", parseMode);
      if (typeof input.replyToMessageId === "number") {
        form.set("reply_to_message_id", String(input.replyToMessageId));
      }
      return telegramFetchMultipart<TelegramMessage>(token, "sendPhoto", form);
    });
  }

  async sendDocument(input: SendMediaInput): Promise<TelegramMessage> {
    return this.withScope(TELEGRAM_BOT_SCOPES.send, async () => {
      const token = await requireBotToken();
      const parseMode = input.parseMode ?? (await this.defaultParseMode());
      const filePath = truthyPath(input.path);
      if (!filePath) {
        const source = input.url ?? input.fileId;
        if (!source) {
          throw new IntegrationConfigError(
            "messages_send_document requires exactly one of: url, fileId, path.",
            { integrationId: "telegram" },
          );
        }
        const body: Record<string, unknown> = {
          chat_id: input.chatId,
          document: source,
        };
        if (input.caption) body.caption = input.caption;
        if (parseMode) body.parse_mode = parseMode;
        if (typeof input.replyToMessageId === "number") body.reply_to_message_id = input.replyToMessageId;
        try {
          return await telegramFetch<TelegramMessage>(token, "sendDocument", body);
        } catch (err) {
          if (isTransientError(err)) {
            await enqueue({ method: "sendDocument", payload: body, error: (err as Error).message });
          }
          throw err;
        }
      }
      const { data, filename } = await readForUpload(filePath);
      const form = new FormData();
      form.set("chat_id", String(input.chatId));
      form.set("document", new Blob([new Uint8Array(data)]), filename);
      if (input.caption) form.set("caption", input.caption);
      if (parseMode) form.set("parse_mode", parseMode);
      if (typeof input.replyToMessageId === "number") {
        form.set("reply_to_message_id", String(input.replyToMessageId));
      }
      return telegramFetchMultipart<TelegramMessage>(token, "sendDocument", form);
    });
  }

  async replyToMessage(input: ReplyInput): Promise<TelegramMessage> {
    return this.sendMessage({
      chatId: input.chatId,
      text: input.text,
      parseMode: input.parseMode,
      replyToMessageId: input.messageId,
    });
  }

  async forwardMessage(input: ForwardInput): Promise<TelegramMessage> {
    return this.withScope(TELEGRAM_BOT_SCOPES.send, async () => {
      const token = await requireBotToken();
      const body: Record<string, unknown> = {
        chat_id: input.toChatId,
        from_chat_id: input.fromChatId,
        message_id: input.messageId,
        disable_notification: input.disableNotification ?? false,
      };
      return telegramFetch<TelegramMessage>(token, "forwardMessage", body);
    });
  }

  async deleteMessage(input: DeleteInput): Promise<{ ok: true }> {
    return this.withScope(TELEGRAM_BOT_SCOPES.manage, async () => {
      const token = await requireBotToken();
      await telegramFetch<boolean>(token, "deleteMessage", {
        chat_id: input.chatId,
        message_id: input.messageId,
      });
      return { ok: true } as const;
    });
  }

  async editMessage(input: EditInput): Promise<TelegramMessage | { ok: true }> {
    return this.withScope(TELEGRAM_BOT_SCOPES.send, async () => {
      const token = await requireBotToken();
      const parseMode = input.parseMode ?? (await this.defaultParseMode());
      const body: Record<string, unknown> = {
        chat_id: input.chatId,
        message_id: input.messageId,
        text: input.text,
        disable_web_page_preview: input.disableWebPagePreview ?? false,
      };
      if (parseMode) body.parse_mode = parseMode;
      // editMessageText returns either the edited Message or `true` if the
      // message was inline (out of scope for us). We surface `{ ok: true }`
      // for the boolean form so callers get a stable shape.
      const result = await telegramFetch<TelegramMessage | boolean>(token, "editMessageText", body);
      if (result === true) return { ok: true } as const;
      return result as TelegramMessage;
    });
  }

  async pinMessage(input: PinInput): Promise<{ ok: true }> {
    return this.withScope(TELEGRAM_BOT_SCOPES.manage, async () => {
      const token = await requireBotToken();
      await telegramFetch<boolean>(token, "pinChatMessage", {
        chat_id: input.chatId,
        message_id: input.messageId,
        disable_notification: input.disableNotification ?? false,
      });
      return { ok: true } as const;
    });
  }

  async unpinMessage(input: UnpinInput): Promise<{ ok: true }> {
    return this.withScope(TELEGRAM_BOT_SCOPES.manage, async () => {
      const token = await requireBotToken();
      const body: Record<string, unknown> = { chat_id: input.chatId };
      if (typeof input.messageId === "number") body.message_id = input.messageId;
      await telegramFetch<boolean>(token, "unpinChatMessage", body);
      return { ok: true } as const;
    });
  }

  async getChat(chatId: string | number): Promise<Record<string, unknown>> {
    return this.withScope(TELEGRAM_BOT_SCOPES.read, async () => {
      const token = await requireBotToken();
      return telegramFetch<Record<string, unknown>>(token, "getChat", { chat_id: chatId });
    });
  }

  async answerCallback(input: AnswerCallbackInput): Promise<{ ok: true }> {
    return this.withScope(TELEGRAM_BOT_SCOPES.send, async () => {
      const token = await requireBotToken();
      const body: Record<string, unknown> = { callback_query_id: input.callbackQueryId };
      if (input.text) body.text = input.text;
      if (input.showAlert) body.show_alert = input.showAlert;
      await telegramFetch<boolean>(token, "answerCallbackQuery", body);
      return { ok: true } as const;
    });
  }

  async setCommands(commands: BotCommand[]): Promise<{ ok: true }> {
    return this.withScope(TELEGRAM_BOT_SCOPES.manage, async () => {
      const token = await requireBotToken();
      await telegramFetch<boolean>(token, "setMyCommands", { commands });
      return { ok: true } as const;
    });
  }

  /**
   * Route a message through the configured sub-agent and post its reply. Thin
   * wrapper around agent-router.routeManualMessage — kept on the adapter so it
   * appears as an assistant action (see bot-methods.ts).
   */
  async routeMessage(input: {
    chatId: string | number;
    text: string;
    agentId?: string;
    contextDepth?: number;
  }): Promise<{ handled: boolean; replyText?: string; error?: string }> {
    return this.withScope(TELEGRAM_BOT_SCOPES.send, async () => {
      const { routeManualMessage } = await import("../agent-router");
      return routeManualMessage(input);
    });
  }

  async getUpdates(input: GetUpdatesInput = {}): Promise<TelegramUpdate[]> {
    return this.withScope(TELEGRAM_BOT_SCOPES.read, async () => {
      const token = await requireBotToken();
      const body: Record<string, unknown> = {};
      if (typeof input.offset === "number") body.offset = input.offset;
      if (typeof input.limit === "number") body.limit = Math.max(1, Math.min(100, input.limit));
      if (typeof input.timeout === "number") body.timeout = Math.max(0, Math.min(50, input.timeout));
      if (input.allowedUpdates?.length) body.allowed_updates = input.allowedUpdates;
      return telegramFetch<TelegramUpdate[]>(token, "getUpdates", body);
    });
  }

  /**
   * Scheduler hook — reads pending updates via long-poll, translates each into
   * an `IntegrationEvent`, and advances the persisted `offset` so the next
   * tick starts after the last delivered update.
   *
   * `since` from the scheduler is ignored (Telegram tracks progress via
   * update_id, not timestamps). We store the acked offset in
   * `state.services.bot.config.updateOffset`.
   */
  async pollOnce(): Promise<PollOnceResult> {
    return this.withScope(TELEGRAM_BOT_SCOPES.read, async () => {
      // Opportunistic: drain any queued sends on the same tick. Failures are
      // captured inside flushQueueOnce so they never abort the update fetch.
      await flushQueueOnce().catch(() => {});
      const state = await this.getState();
      const svcConfig = state.services["bot"]?.config ?? {};
      const previousOffset = typeof svcConfig.updateOffset === "number" ? svcConfig.updateOffset : 0;
      const allowedUpdates = Array.isArray(svcConfig.allowedUpdates)
        ? (svcConfig.allowedUpdates as string[])
        : undefined;
      const updates = await this.getUpdates({
        offset: previousOffset,
        limit: 100,
        // Short poll from the scheduler tick — the scheduler already sleeps.
        timeout: 0,
        allowedUpdates,
      });
      const events: IntegrationEvent[] = [];
      let maxId = previousOffset - 1;
      for (const u of updates) {
        if (u.update_id > maxId) maxId = u.update_id;
        events.push(updateToEvent(u));
      }
      if (updates.length > 0) {
        // Persist next offset. Written to state.services.bot.config.updateOffset
        // so the framework's mutateState is used (mutex + atomic write).
        const { mutateState } = await import("../../../state/store");
        await mutateState("telegram", (prev) => {
          const services = { ...prev.services };
          const existing = services["bot"] ?? { enabled: true, config: {} };
          services["bot"] = {
            ...existing,
            config: {
              ...(existing.config ?? {}),
              updateOffset: maxId + 1,
            },
          };
          return { ...prev, services };
        });
        // Route each inbound update through the agent router. Runs after offset
        // is persisted so a router crash can't cause the same update to route
        // twice on the next tick. Sequential to avoid interleaving replies
        // within one chat. routeUpdate never throws — errors are logged inside.
        const { routeUpdate } = await import("../agent-router");
        for (const u of updates) {
          await routeUpdate(u);
        }
      }
      return { newMessages: events.length, events };
    });
  }
}

// Translate a Telegram Update into a BOS IntegrationEvent. Kept exported so
// the webhook handler emits the exact same shape as long-poll.
export function updateToEvent(u: TelegramUpdate): IntegrationEvent {
  const message = u.message ?? u.channel_post ?? u.edited_message ?? u.edited_channel_post;
  const callback = u.callback_query;
  const type =
    u.message ? "telegram_message" :
    u.channel_post ? "telegram_channel_post" :
    u.edited_message ? "telegram_message_edited" :
    u.edited_channel_post ? "telegram_channel_post_edited" :
    u.callback_query ? "telegram_callback_query" :
    "telegram_update";
  const timestamp = message?.date ? message.date * 1000 : Date.now();
  return {
    type,
    service: "telegram/bot",
    timestamp,
    data: {
      updateId: u.update_id,
      message,
      callbackQuery: callback,
    },
  };
}

// --- Method registry -----------------------------------------------------

const INVOKERS: Record<
  BotMethodName,
  (adapter: TelegramBotAdapter, args: Record<string, unknown>) => Promise<unknown>
> = {
  bot_get_me: (a) => a.getMe(),
  messages_send: (a, args) =>
    a.sendMessage({
      chatId: String(args.chatId),
      text: String(args.text),
      parseMode: args.parseMode as SendMessageInput["parseMode"],
      disableWebPagePreview: args.disableWebPagePreview as boolean | undefined,
      disableNotification: args.disableNotification as boolean | undefined,
      replyToMessageId: args.replyToMessageId as number | undefined,
    }),
  messages_send_photo: (a, args) =>
    a.sendPhoto({
      chatId: String(args.chatId),
      url: args.url as string | undefined,
      fileId: args.fileId as string | undefined,
      path: args.path as string | undefined,
      caption: args.caption as string | undefined,
      parseMode: args.parseMode as SendMediaInput["parseMode"],
      replyToMessageId: args.replyToMessageId as number | undefined,
    }),
  messages_send_document: (a, args) =>
    a.sendDocument({
      chatId: String(args.chatId),
      url: args.url as string | undefined,
      fileId: args.fileId as string | undefined,
      path: args.path as string | undefined,
      caption: args.caption as string | undefined,
      parseMode: args.parseMode as SendMediaInput["parseMode"],
      replyToMessageId: args.replyToMessageId as number | undefined,
    }),
  messages_reply: (a, args) =>
    a.replyToMessage({
      chatId: String(args.chatId),
      messageId: Number(args.messageId),
      text: String(args.text),
      parseMode: args.parseMode as ReplyInput["parseMode"],
    }),
  messages_forward: (a, args) =>
    a.forwardMessage({
      toChatId: String(args.toChatId),
      fromChatId: String(args.fromChatId),
      messageId: Number(args.messageId),
      disableNotification: args.disableNotification as boolean | undefined,
    }),
  messages_delete: (a, args) =>
    a.deleteMessage({ chatId: String(args.chatId), messageId: Number(args.messageId) }),
  messages_edit: (a, args) =>
    a.editMessage({
      chatId: String(args.chatId),
      messageId: Number(args.messageId),
      text: String(args.text),
      parseMode: args.parseMode as EditInput["parseMode"],
      disableWebPagePreview: args.disableWebPagePreview as boolean | undefined,
    }),
  chats_pin_message: (a, args) =>
    a.pinMessage({
      chatId: String(args.chatId),
      messageId: Number(args.messageId),
      disableNotification: args.disableNotification as boolean | undefined,
    }),
  chats_unpin_message: (a, args) =>
    a.unpinMessage({
      chatId: String(args.chatId),
      messageId: args.messageId != null ? Number(args.messageId) : undefined,
    }),
  chats_get: (a, args) => a.getChat(String(args.chatId)),
  bot_answer_callback: (a, args) =>
    a.answerCallback({
      callbackQueryId: String(args.callbackQueryId),
      text: args.text as string | undefined,
      showAlert: args.showAlert as boolean | undefined,
    }),
  bot_set_commands: (a, args) => a.setCommands((args.commands ?? []) as BotCommand[]),
  updates_get: (a, args) =>
    a.getUpdates({
      offset: args.offset as number | undefined,
      limit: args.limit as number | undefined,
      timeout: args.timeout as number | undefined,
    }),
  agent_route_message: (a, args) =>
    a.routeMessage({
      chatId: String(args.chatId),
      text: String(args.text),
      agentId: args.agentId as string | undefined,
      contextDepth: args.contextDepth as number | undefined,
    }),
};

export const TELEGRAM_BOT_METHODS: readonly AdapterMethodMeta<TelegramBotAdapter>[] =
  TELEGRAM_BOT_METHOD_DESCRIPTORS.map((d) => ({
    method: d.method,
    scope: d.scope,
    description: d.description,
    parameters: d.parameters,
    invoke: INVOKERS[d.method],
  }));

// Register with the server-side adapter registry at module load.
if (!_getAdapterEntry("telegram", "bot")) {
  registerAdapter("telegram", "bot", {
    createAdapter: () => new TelegramBotAdapter(),
    methods: TELEGRAM_BOT_METHODS,
    capabilities: { poll: true, webhook: true },
  });
}
