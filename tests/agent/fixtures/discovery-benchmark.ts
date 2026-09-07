// SC-004 benchmark for find_tools ranking (041-tool-groups).
//
// COMMITTED BEFORE THE RANKING WAS TUNED (plan.md T011, risk R5). The point of
// writing these first is that a benchmark authored afterwards gets fitted to
// whatever the implementation already does; this one was written from "how
// would a user actually phrase this?" with the implementation unwritten.
//
// Rules every entry follows:
//   - phrased as a person would ask, not as a tool name;
//   - shares NO literal word with the target tool's id (the id-word rule is the
//     one signal the old scorer already had — these must be found some other
//     way: description, group name, group description, or a curated alias);
//   - the expected tool is unambiguously the right answer for the phrasing.
//
// Target: expectedId within the top 3 results.

export interface BenchmarkCase {
  query: string;
  expectedId: string;
  /** Which signal SHOULD carry it, for diagnosing a regression. */
  via: "description" | "group" | "alias";
}

export const DISCOVERY_BENCHMARK: readonly BenchmarkCase[] = [
  // ── Integrations: the classic "vocabulary gap" cases ──────────────────────
  { query: "send a note to my colleague", expectedId: "gmail_messages_send", via: "alias" },
  { query: "what unread mail do I have", expectedId: "gmail_messages_list", via: "alias" },
  { query: "book a meeting with the team next tuesday", expectedId: "calendar_events_create", via: "alias" },
  { query: "when am I free this week", expectedId: "calendar_freebusy_query", via: "description" },
  { query: "look up someone's phone number", expectedId: "contacts_contacts_search", via: "alias" },
  { query: "grab that spreadsheet from cloud storage", expectedId: "drive_files_list", via: "alias" },

  // ── Files: morphology + document vocabulary ───────────────────────────────
  { query: "what is inside this PDF", expectedId: "file_to_markdown", via: "description" },
  { query: "show me the pictures in that folder", expectedId: "file_list", via: "alias" },
  { query: "find every place we mention the licence terms", expectedId: "file_search", via: "description" },
  { query: "look at this screenshot for me", expectedId: "view_image", via: "description" },
  { query: "grab some frames out of that clip", expectedId: "video_keyframes", via: "description" },

  // ── Scheduler: the group with NO common name prefix ───────────────────────
  { query: "run this every morning at eight", expectedId: "create_scheduled_task", via: "alias" },
  { query: "stop that recurring job for now", expectedId: "pause_scheduled_task", via: "alias" },
  { query: "what automations do I have set up", expectedId: "list_scheduled_tasks", via: "alias" },

  // ── Memory / skills / scratchpad: overlapping vocabulary, must not collide ─
  { query: "remember that I prefer metric units", expectedId: "memory_save", via: "alias" },
  { query: "what do you know about my preferences already", expectedId: "memory_recall", via: "alias" },
  { query: "jot this down for the rest of our chat", expectedId: "scratchpad_write", via: "alias" },
  { query: "is there a playbook for this kind of task", expectedId: "skill_list", via: "alias" },

  // ── OS / web ──────────────────────────────────────────────────────────────
  { query: "change my background picture", expectedId: "bos_wallpaper_set", via: "description" },
  { query: "look that up online", expectedId: "web_search", via: "alias" },
  { query: "read this article for me", expectedId: "web_fetch", via: "description" },

  // ── Dev / config / apps ───────────────────────────────────────────────────
  { query: "what have I changed on this branch", expectedId: "dev_git_status", via: "alias" },
  { query: "execute a shell command", expectedId: "run_command", via: "description" },
  { query: "turn that preference off", expectedId: "config_set", via: "alias" },
  { query: "get rid of that application", expectedId: "app_uninstall", via: "alias" },

  // ── Conflict resolution: rare vocabulary, must still be reachable ─────────
  { query: "help me sort out this merge mess", expectedId: "conflict_read", via: "alias" },
];

/** Queries that must return NOTHING above threshold — the negative half of the
 *  benchmark. A ranking that returns something for everything is not ranking.
 *  Each is a plausible sentence with no corresponding capability. */
export const DISCOVERY_NEGATIVES: readonly string[] = [
  "order me a pizza",
  "what is the capital of France",
  "translate this into Norwegian",
];

/** Queries that must NOT be matched on a stopword alone (FR-018/SC-005).
 *  `file_to_markdown` contains the word "to"; "send an email to bob" must not
 *  surface it for that reason. */
export const STOPWORD_TRAPS: readonly { query: string; mustNotReturn: string }[] = [
  { query: "send an email to bob", mustNotReturn: "file_to_markdown" },
  // "about" is a stopword; without that, any sentence containing it hits
  // drive_about_get, which is about Drive's ACCOUNT metadata.
  { query: "tell me more about that in detail", mustNotReturn: "drive_about_get" },
];
