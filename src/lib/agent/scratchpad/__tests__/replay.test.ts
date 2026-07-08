// Hand-run unit tests for scratchpad extract/replay logic (matches the pattern
// in drive-adapter.test.ts). Verifies that a conversation's messages[] array
// can be walked to reconstruct the current note state.

import { readNotes } from "../handlers";
import { ensureInitialized, extractScratchpadOps, replayOperations } from "../replay";
import { getNotes, resetScratchpadForTests } from "../store";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function reset(): void {
  resetScratchpadForTests();
}

// Build a plausible assistant message carrying a single scratchpad tool call.
function toolCallMsg(name: string, args: Record<string, unknown>, id: string): unknown {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [{ id: `tc-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

export async function testExtractBasicSequence(): Promise<void> {
  const messages = [
    { id: "u1", role: "user", content: "make a note" },
    toolCallMsg("scratchpad_write", { title: "A", content: "one" }, "m1"),
    toolCallMsg("scratchpad_edit", { title: "A", content: "one-plus" }, "m2"),
    toolCallMsg("scratchpad_delete", { title: "A" }, "m3"),
  ];
  const ops = extractScratchpadOps(messages);
  assert(ops.length === 3, `expected 3 ops, got ${ops.length}`);
  assert(ops[0].kind === "write" && ops[0].title === "A" && ops[0].content === "one", "write op preserved");
  assert(ops[1].kind === "edit" && ops[1].content === "one-plus", "edit op preserved");
  assert(ops[2].kind === "delete", "delete op preserved");
}

export async function testExtractSkipsNonScratchpad(): Promise<void> {
  const messages = [
    toolCallMsg("skill_list", {}, "m1"),
    toolCallMsg("scratchpad_write", { title: "K", content: "v" }, "m2"),
    toolCallMsg("workflow_run", { id: "wf1" }, "m3"),
  ];
  const ops = extractScratchpadOps(messages);
  assert(ops.length === 1 && ops[0].kind === "write" && ops[0].title === "K", "only scratchpad_write kept");
}

export async function testExtractSkipsMalformed(): Promise<void> {
  const messages = [
    // Missing arguments string
    { id: "m1", role: "assistant", toolCalls: [{ type: "function", function: { name: "scratchpad_write" } }] },
    // Non-JSON arguments
    { id: "m2", role: "assistant", toolCalls: [{ type: "function", function: { name: "scratchpad_write", arguments: "not json" } }] },
    // Missing title
    toolCallMsg("scratchpad_write", { content: "orphan" }, "m3"),
    // Good one — should survive
    toolCallMsg("scratchpad_write", { title: "OK", content: "yes" }, "m4"),
  ];
  const ops = extractScratchpadOps(messages);
  assert(ops.length === 1 && ops[0].title === "OK", `expected exactly the well-formed op, got ${ops.length}`);
}

export async function testReplayReconstructsCurrentState(): Promise<void> {
  reset();
  const CID = "conv-replay-1";
  const messages = [
    toolCallMsg("scratchpad_write", { title: "A", content: "one" }, "m1"),
    toolCallMsg("scratchpad_write", { title: "B", content: "two" }, "m2"),
    toolCallMsg("scratchpad_edit", { title: "A", content: "one-edited" }, "m3"),
    toolCallMsg("scratchpad_delete", { title: "B" }, "m4"),
  ];
  const ops = extractScratchpadOps(messages);
  replayOperations(CID, ops);
  const list = readNotes(CID);
  assert(list.success === true && list.total === 1, `expected 1 note after replay, got ${list.success ? list.total : "err"}`);
  const a = readNotes(CID, "A");
  assert(a.success === true && a.note?.content === "one-edited", "A has edited content");
  const b = readNotes(CID, "B");
  assert(b.success === false, "B removed by delete op");
}

export async function testReplayIgnoresEditOnMissingNote(): Promise<void> {
  reset();
  const CID = "conv-replay-2";
  const messages = [
    toolCallMsg("scratchpad_edit", { title: "Ghost", content: "x" }, "m1"),
    toolCallMsg("scratchpad_delete", { title: "Ghost" }, "m2"),
    toolCallMsg("scratchpad_write", { title: "Real", content: "y" }, "m3"),
  ];
  replayOperations(CID, extractScratchpadOps(messages));
  const list = readNotes(CID);
  assert(list.success === true && list.total === 1, "only the write should have taken effect");
  const real = readNotes(CID, "Real");
  assert(real.success === true && real.note?.content === "y", "Real note preserved");
}

export async function testReplayClearsPriorState(): Promise<void> {
  reset();
  const CID = "conv-replay-3";
  // Prime the map with stale state that isn't in the "history" we're about to
  // replay — replay must reset the Map so it reflects only the ops.
  getNotes(CID).set("Stale", {
    id: "stale-1",
    title: "Stale",
    content: "old",
    created: "1970-01-01T00:00:00.000Z",
    modified: "1970-01-01T00:00:00.000Z",
  });
  const messages = [toolCallMsg("scratchpad_write", { title: "Fresh", content: "new" }, "m1")];
  replayOperations(CID, extractScratchpadOps(messages));
  const list = readNotes(CID);
  assert(list.success === true && list.total === 1, "replay should replace prior state");
  assert(readNotes(CID, "Stale").success === false, "stale note should be gone");
}

export async function testEnsureInitializedIsIdempotent(): Promise<void> {
  reset();
  const CID = "conv-init-1";
  let calls = 0;
  const loader = async (): Promise<unknown[]> => {
    calls++;
    return [toolCallMsg("scratchpad_write", { title: "X", content: "1" }, "m1")];
  };
  await ensureInitialized(CID, loader);
  await ensureInitialized(CID, loader);
  await ensureInitialized(CID, loader);
  assert(calls === 1, `expected loader to run exactly once, got ${calls}`);
  assert(readNotes(CID, "X").success === true, "note should be present after init");
}

export async function testEnsureInitializedHandlesEmptyHistory(): Promise<void> {
  reset();
  const CID = "conv-init-empty";
  await ensureInitialized(CID, async () => []);
  const list = readNotes(CID);
  assert(list.success === true && list.total === 0, "empty history yields empty scratchpad");
}

export async function testEnsureInitializedHandlesLoaderError(): Promise<void> {
  reset();
  const CID = "conv-init-fail";
  await ensureInitialized(CID, async () => {
    throw new Error("boom");
  });
  const list = readNotes(CID);
  assert(list.success === true && list.total === 0, "loader error should degrade to empty state");
}

export async function runAll(): Promise<void> {
  await testExtractBasicSequence();
  await testExtractSkipsNonScratchpad();
  await testExtractSkipsMalformed();
  await testReplayReconstructsCurrentState();
  await testReplayIgnoresEditOnMissingNote();
  await testReplayClearsPriorState();
  await testEnsureInitializedIsIdempotent();
  await testEnsureInitializedHandlesEmptyHistory();
  await testEnsureInitializedHandlesLoaderError();
}
