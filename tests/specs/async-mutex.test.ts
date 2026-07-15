// Unit tests for the in-process async mutex used by the feature-context module
// (027-vfs-specfs) — the guarantee that concurrent RMW never loses updates.
import { test } from "@playwright/test";
import { strict as assert } from "node:assert";
import { AsyncMutex } from "../../src/os/async-mutex";

test("serializes concurrent read-modify-write without lost updates", async () => {
  const mutex = new AsyncMutex();
  const shared: number[] = [];
  const N = 100;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      mutex.run(async () => {
        const snapshot = shared.length;
        await new Promise((r) => setTimeout(r, 0));
        shared.push(snapshot + i);
      }),
    ),
  );
  assert.equal(shared.length, N);
});

test("a rejecting section does not wedge the queue", async () => {
  const mutex = new AsyncMutex();
  await assert.rejects(
    mutex.run(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await mutex.run(async () => 42), 42);
});

test("preserves arrival order", async () => {
  const mutex = new AsyncMutex();
  const order: number[] = [];
  await Promise.all([
    mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
    }),
    mutex.run(async () => {
      order.push(2);
    }),
  ]);
  assert.deepEqual(order, [1, 2]);
});
