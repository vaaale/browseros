import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError, IntegrationError } from "../../../errors";
import type { AdapterMethodMeta } from "../../../actions/types";
import type { ServiceDefinition } from "../../../types";
import { registerAdapter, getAdapterEntry as _getAdapterEntry } from "../../../actions/adapter-registry";
import { TELEGRAM_USER_METHOD_DESCRIPTORS, type UserMethodName } from "./user-methods";

// Stubbed adapter for the user-account (MTProto) service. Phase 2 will wire
// this up to a proper MTProto client (api_id + api_hash + phone-code flow).
// Right now every method throws `not_implemented` so the LLM sees a graceful
// "coming soon" surface. No poll/webhook capability is declared.

function serviceDef(): ServiceDefinition {
  const svc = getService("telegram", "user");
  if (!svc) {
    throw new IntegrationConfigError("Telegram user service is not registered.", {
      integrationId: "telegram",
    });
  }
  return svc;
}

function notImplemented(method: string): never {
  throw new IntegrationError(
    "not_implemented",
    `${method} is coming in Phase 2 (user-account MTProto support). Use the Telegram Bot service for now.`,
    { integrationId: "telegram" },
  );
}

export class TelegramUserAdapter extends ServiceAdapter {
  constructor() {
    super("telegram", serviceDef());
  }

  async sendMessage(): Promise<never> {
    notImplemented("user_send_message");
  }

  async listContacts(): Promise<never> {
    notImplemented("user_list_contacts");
  }
}

const INVOKERS: Record<UserMethodName, (adapter: TelegramUserAdapter) => Promise<unknown>> = {
  user_send_message: (a) => a.sendMessage(),
  user_list_contacts: (a) => a.listContacts(),
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
    // No poll / webhook — Phase 2 will enable them.
    capabilities: {},
  });
}
