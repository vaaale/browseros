import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { integrationsRoot } from "../../paths";

// Paths for Telegram-specific persistent state (offline send queue).
//
// Layout:
//   data/integrations/telegram/queue.json     — offline send queue
//   data/integrations/telegram/state.json     — standard framework state (see ../../paths.ts)
//
// Secrets (bot token) live in the shared SecretsStore, not here.

export function telegramDir(): string {
  return path.join(integrationsRoot(), "telegram");
}

export function queueFile(): string {
  return path.join(telegramDir(), "queue.json");
}

export async function ensureTelegramDir(): Promise<void> {
  await fs.mkdir(telegramDir(), { recursive: true });
}
