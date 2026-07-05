// Hand-run unit tests for scratchpad CRUD handlers. No test runner is wired into
// package.json — matches the pattern in src/lib/integrations/__tests__/drive-adapter.test.ts.
// Callable async functions plus a `runAll()` entry so the suite can be executed
// from an ad-hoc node script or wrapped in describe/it once a runner ships.

import { deleteNote, editNote, readNotes, writeNote } from "../handlers";
import { resetScratchpadForTests } from "../store";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const CID = "conv-test";

function reset(): void {
  resetScratchpadForTests();
}

export async function testWriteNoteSuccess(): Promise<void> {
  reset();
  const res = writeNote(CID, "Ideas", "First brainstorm");
  assert(res.success === true, "expected success");
  if (res.success) {
    assert(typeof res.noteId === "string" && res.noteId.length > 0, "expected a noteId");
    assert(res.message?.includes("Ideas"), "expected message to reference title");
  }
}

export async function testWriteNoteDuplicateTitleFails(): Promise<void> {
  reset();
  writeNote(CID, "Ideas", "First");
  const dup = writeNote(CID, "Ideas", "Second");
  assert(dup.success === false, "duplicate write should fail");
  if (!dup.success) assert(dup.error === "NOTE_EXISTS", `expected NOTE_EXISTS, got ${dup.error}`);
}

export async function testWriteNoteInvalidTitle(): Promise<void> {
  reset();
  const r1 = writeNote(CID, "", "body");
  assert(r1.success === false, "empty title should be rejected");
  if (!r1.success) assert(r1.error === "INVALID_TITLE", "expected INVALID_TITLE");
  const r2 = writeNote(CID, "   ", "body");
  assert(r2.success === false, "whitespace-only title should be rejected");
  const r3 = writeNote(CID, 42 as unknown as string, "body");
  assert(r3.success === false, "non-string title should be rejected");
}

export async function testWriteNoteEmptyContentAllowed(): Promise<void> {
  reset();
  const res = writeNote(CID, "Blank", "");
  assert(res.success === true, "empty content should be allowed");
  const read = readNotes(CID, "Blank");
  assert(read.success === true && read.note?.content === "", "empty content stored");
}

export async function testReadNotesSingleFound(): Promise<void> {
  reset();
  writeNote(CID, "Ideas", "brainstorm");
  const res = readNotes(CID, "Ideas");
  assert(res.success === true, "read should succeed");
  if (res.success) {
    assert(res.note?.title === "Ideas", "expected note title");
    assert(res.note?.content === "brainstorm", "expected note content");
  }
}

export async function testReadNotesSingleNotFound(): Promise<void> {
  reset();
  const res = readNotes(CID, "Missing");
  assert(res.success === false, "missing note should fail");
  if (!res.success) assert(res.error === "NOTE_NOT_FOUND", "expected NOTE_NOT_FOUND");
}

export async function testReadNotesListEmpty(): Promise<void> {
  reset();
  const res = readNotes(CID);
  assert(res.success === true, "listing empty should succeed");
  if (res.success) {
    assert(Array.isArray(res.notes) && res.notes.length === 0, "expected empty notes array");
    assert(res.total === 0, "expected total 0");
  }
}

export async function testReadNotesListMultiple(): Promise<void> {
  reset();
  writeNote(CID, "A", "one");
  writeNote(CID, "B", "two-body");
  const res = readNotes(CID);
  assert(res.success === true, "list should succeed");
  if (res.success) {
    assert(res.total === 2, `expected total 2, got ${res.total}`);
    const titles = (res.notes ?? []).map((n) => n.title).sort();
    assert(titles[0] === "A" && titles[1] === "B", "expected titles A,B");
    const b = res.notes?.find((n) => n.title === "B");
    assert(b?.size === "two-body".length, "expected size to reflect content length");
  }
}

export async function testEditNoteSuccessPreservesCreated(): Promise<void> {
  reset();
  const w = writeNote(CID, "Note", "before");
  assert(w.success === true, "write succeeded");
  const before = readNotes(CID, "Note");
  if (!before.success || !before.note) throw new Error("expected note");
  const createdBefore = before.note.created;
  // Ensure the modified timestamp advances even at high resolution.
  await new Promise((r) => setTimeout(r, 5));
  const e = editNote(CID, "Note", "after");
  assert(e.success === true, "edit should succeed");
  const after = readNotes(CID, "Note");
  if (!after.success || !after.note) throw new Error("expected note after edit");
  assert(after.note.content === "after", "content should be updated");
  assert(after.note.created === createdBefore, "created should be preserved");
  assert(after.note.modified >= createdBefore, "modified should be >= created");
}

export async function testEditNoteNotFound(): Promise<void> {
  reset();
  const res = editNote(CID, "Ghost", "body");
  assert(res.success === false, "edit non-existent should fail");
  if (!res.success) assert(res.error === "NOTE_NOT_FOUND", "expected NOTE_NOT_FOUND");
}

export async function testDeleteNoteSuccess(): Promise<void> {
  reset();
  writeNote(CID, "Tmp", "body");
  const res = deleteNote(CID, "Tmp");
  assert(res.success === true, "delete should succeed");
  const missing = readNotes(CID, "Tmp");
  assert(missing.success === false, "note should be gone after delete");
}

export async function testDeleteNoteNotFound(): Promise<void> {
  reset();
  const res = deleteNote(CID, "Ghost");
  assert(res.success === false, "delete non-existent should fail");
  if (!res.success) assert(res.error === "NOTE_NOT_FOUND", "expected NOTE_NOT_FOUND");
}

export async function testConversationIsolation(): Promise<void> {
  reset();
  writeNote("conv-A", "Shared", "from A");
  writeNote("conv-B", "Shared", "from B");
  const a = readNotes("conv-A", "Shared");
  const b = readNotes("conv-B", "Shared");
  assert(a.success === true && a.note?.content === "from A", "conv-A isolated");
  assert(b.success === true && b.note?.content === "from B", "conv-B isolated");
}

export async function runAll(): Promise<void> {
  await testWriteNoteSuccess();
  await testWriteNoteDuplicateTitleFails();
  await testWriteNoteInvalidTitle();
  await testWriteNoteEmptyContentAllowed();
  await testReadNotesSingleFound();
  await testReadNotesSingleNotFound();
  await testReadNotesListEmpty();
  await testReadNotesListMultiple();
  await testEditNoteSuccessPreservesCreated();
  await testEditNoteNotFound();
  await testDeleteNoteSuccess();
  await testDeleteNoteNotFound();
  await testConversationIsolation();
}
