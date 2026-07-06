// Framework-free method metadata for the stubbed Telegram User (MTProto)
// service. Phase 2 will implement these; Phase 1 exposes them so the LLM sees
// a "coming soon" surface and can suggest bot alternatives.

import type { AdapterMethodParameter } from "../../../actions/types";
import { TELEGRAM_USER_SCOPES } from "../manifest";

export type UserMethodName = "user_send_message" | "user_list_contacts";

export interface UserMethodDescriptor {
  method: UserMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

export const TELEGRAM_USER_METHOD_DESCRIPTORS: readonly UserMethodDescriptor[] = [
  {
    method: "user_send_message",
    scope: TELEGRAM_USER_SCOPES.send,
    description:
      "(Coming in Phase 2) Send a message as the connected Telegram user account. Currently returns `not_implemented` — use the bot service instead.",
    parameters: [
      { name: "chatId", type: "string", description: "Target chat id.", required: true },
      { name: "text", type: "string", description: "Message text.", required: true },
    ],
  },
  {
    method: "user_list_contacts",
    scope: TELEGRAM_USER_SCOPES.read,
    description:
      "(Coming in Phase 2) List the connected user's Telegram contacts. Currently returns `not_implemented`.",
    parameters: [],
  },
];
