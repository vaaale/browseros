import "server-only";
import { promises as fs } from "fs";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureIntegrationDir, stateFile } from "../paths";
import type { IntegrationState } from "../types";

// Per-integration state.json store. State is non-sensitive metadata (connect
// status, per-service config, scope overrides, oauth metadata) — actual
// access/refresh tokens live in SecretsStore under `tokens:<id>`.
//
// Read-modify-write is serialised by a per-integration mutex so two parallel
// PATCHes don't clobber each other; writes go through atomic-write.

function defaultState(): IntegrationState {
  return {
    connected: false,
    services: {},
    scopeOverrides: {},
  };
}

const locks = new Map<string, Promise<void>>();

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  locks.set(id, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === next) locks.delete(id);
  }
}

export async function readState(integrationId: string): Promise<IntegrationState> {
  try {
    const raw = await fs.readFile(stateFile(integrationId), "utf8");
    const parsed = JSON.parse(raw) as Partial<IntegrationState>;
    return {
      ...defaultState(),
      ...parsed,
      services: parsed.services ?? {},
      scopeOverrides: parsed.scopeOverrides ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw err;
  }
}

export async function writeState(integrationId: string, state: IntegrationState): Promise<void> {
  await ensureIntegrationDir(integrationId);
  await writeFileAtomic(stateFile(integrationId), JSON.stringify(state, null, 2));
}

export async function mutateState(
  integrationId: string,
  updater: (prev: IntegrationState) => IntegrationState,
): Promise<IntegrationState> {
  return withLock(integrationId, async () => {
    const prev = await readState(integrationId);
    const next = updater(prev);
    await writeState(integrationId, next);
    return next;
  });
}
