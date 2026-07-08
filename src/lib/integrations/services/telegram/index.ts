// Side-effect module: registers the Telegram manifest with the integrations
// registry at import time. The parent barrel `src/lib/integrations/index.ts`
// imports this file so any consumer of the barrel triggers registration.
//
// Adapter self-registration: `adapters/bot.ts` calls `registerAdapter(...)`
// at module load. Importing it here breaks the same circular dependency
// GSuite documents (registry ↔ adapter).

import { registerIntegration } from "../../registry";
import { TELEGRAM_MANIFEST } from "./manifest";

registerIntegration(TELEGRAM_MANIFEST);

import "./adapters/bot";
import "./adapters/user";

export {
  TELEGRAM_MANIFEST,
  TELEGRAM_BOT_SCOPES,
  TELEGRAM_USER_SCOPES,
} from "./manifest";
