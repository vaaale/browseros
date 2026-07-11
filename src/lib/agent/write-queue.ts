// Per-key async task serialization. Framework-free (usable from client, server,
// or tests). Used to make conversation-file persistence single-writer: every
// read-modify-write of /Documents/Chats/<id>.json runs as a queued critical
// section keyed by the conversation id, so concurrent writers (debounced saves,
// RUN_ERROR flush, rename/agent/branch changes, a second mounted surface in the
// same page) can never interleave. Distinct keys run concurrently.

const chains = new Map<string, Promise<unknown>>();

/** Run `task` after all previously enqueued tasks for `key` have settled.
 *  Returns the task's own promise (rejections propagate to the caller but do
 *  not poison the chain — the next task for the key still runs). */
export function enqueuePerKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

/** Number of keys with an unsettled chain (test/diagnostic aid). */
export function pendingKeyCount(): number {
  return chains.size;
}
