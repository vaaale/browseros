import "server-only";
import { readBotToken } from "./auth";
import { telegramFetch } from "./client";
import { collectDue, QUEUE_MAX_ATTEMPTS, recordFailure, remove } from "./queue";
import { IntegrationAuthError, IntegrationError } from "../../errors";

// Offline queue flush worker. Called opportunistically by the scheduler tick
// (see `TelegramBotAdapter.pollOnce` — which piggy-backs on the shared job
// runner) so we don't need a second daemon.
//
// Strategy: fetch every due entry, attempt to replay it via telegramFetch,
// and remove on success. On failure record the error + push nextAttemptAt
// out with exponential backoff. Auth failures short-circuit (there's no
// point retrying a revoked token) and drop the entry. Permanent 4xx errors
// (invalid chat id, banned by user) also drop.

function isPermanent(err: unknown): boolean {
  if (err instanceof IntegrationAuthError) return true;
  if (err instanceof IntegrationError && err.code.startsWith("telegram_api_error_4")) return true;
  return false;
}

/**
 * Drain due entries from the queue. Never throws — errors are recorded per
 * entry. Returns { sent, dropped, deferred } counts for observability.
 */
export async function flushQueueOnce(): Promise<{ sent: number; dropped: number; deferred: number }> {
  let sent = 0;
  let dropped = 0;
  let deferred = 0;
  const token = await readBotToken();
  if (!token) {
    // Disconnected — nothing to do; leave entries in queue.
    return { sent: 0, dropped: 0, deferred: 0 };
  }
  const due = await collectDue();
  for (const entry of due) {
    try {
      // Only JSON-body sends are queued (see adapter). Multipart uploads are
      // not queued because the underlying file may have moved by retry time.
      await telegramFetch(token, entry.method, entry.payload);
      await remove(entry.id);
      sent++;
    } catch (err) {
      if (isPermanent(err)) {
        await remove(entry.id);
        dropped++;
        continue;
      }
      const message = (err as Error).message ?? "send failed";
      const updated = await recordFailure(entry.id, message);
      if (updated && updated.attempts >= QUEUE_MAX_ATTEMPTS) {
        await remove(entry.id);
        dropped++;
      } else {
        deferred++;
      }
    }
  }
  return { sent, dropped, deferred };
}
