// Data model for the conversation-scoped scratchpad (see
// user-specs/scratchpad/spec.md). Framework-free: shared by store/replay/handlers
// and by the CopilotKit action wrappers in src/components/agent/ScratchpadActions.tsx.

export interface Note {
  id: string;
  title: string;
  content: string;
  // ISO 8601 timestamps. `created` is set on scratchpad_write; `modified` starts
  // equal to `created` and is refreshed on scratchpad_edit.
  created: string;
  modified: string;
}

// Metadata returned when listing notes (no `content`, plus a byte size hint).
export interface NoteMetadata {
  id: string;
  title: string;
  created: string;
  modified: string;
  size: number;
}

// Uniform result envelope for all four scratchpad_* actions. Kept as a
// discriminated union on `success` so callers can narrow with a single check.
export type ToolResult =
  | {
      success: true;
      noteId?: string;
      message?: string;
      notes?: NoteMetadata[];
      total?: number;
      note?: Note;
    }
  | {
      success: false;
      error: ErrorCode;
      message: string;
    };

export type ErrorCode =
  | "NOTE_NOT_FOUND"
  | "NOTE_EXISTS"
  | "INVALID_TITLE"
  | "VALIDATION_ERROR";

// One replayed scratchpad tool invocation extracted from conversation history.
// `timestamp` is best-effort (falls back to insertion order) — replay does not
// require monotonic timestamps because messages are already ordered.
export interface ScratchpadOperation {
  kind: "write" | "edit" | "delete";
  title: string;
  content?: string;
  timestamp: string;
}
