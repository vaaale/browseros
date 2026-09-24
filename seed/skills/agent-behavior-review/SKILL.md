---
name: Agent Behavior Review
description: The conversation-reviewer agent's method, in two modes. Mode 1 — review a past BOS agent conversation for BEHAVIORAL problems (wrong tool calls, missed/misdirected delegation, ignored instructions, false success reports, internal contradictions in what an agent wrote) and propose — never apply — fixes to the agent's prompt, its skills, or BOS's docs. Mode 2 (the Diagnostician, spec 031-self-healing) — given a failure signature, diagnose whether it is a genuine gap in BOS or a usage error, and classify the fix surface into one of six scope classes.
when_to_use: When asked to review a conversation for agent-behavior issues and produce a proposed-improvements report (Mode 1), or when given a failure signature and a self-heal case id to diagnose (Mode 2).
created_by: seed
pinned: true
---

This skill is the method behind the `conversation-reviewer` agent, which operates in two modes. **Which mode you are in is decided by your input, not by you:** a `conversationId` means Mode 1 (everything up to "Report schema" below); a **failure signature plus a self-heal case id** means Mode 2 (the "Mode 2: Gap Diagnosis" section at the end). Both end in exactly one markdown report under `/Documents/BOS Improvements/`, and neither ever applies a change.

## Mode 1 — behavioral review

This part of the skill is the method behind Mode 1. Its job is narrow and specific: given a conversation another BOS agent had, find places where THAT AGENT behaved wrong — not where the user's request was ambiguous, not where BOS itself has a bug unrelated to agent behavior (though note those too, briefly, if you trip over one) — and propose concrete, targeted fixes to the artifacts that actually govern that agent's behavior. You propose. You never apply.

## What counts as a finding (and what doesn't)

A finding is about **how the agent behaved**, evidenced by specific messages in the transcript, not a vague impression. The categories below are drawn from real incidents — use them as a checklist, not an exhaustive list:

- **`wrong-tool-namespace`** — using a VFS-scoped tool (`file_read`/`file_write`) on a real container path, or a real-filesystem tool (`run_command`) on a VFS path like `/Specs/...` or `/mockups/...`. Signature: an error like "No such file or directory" that the agent doesn't recognize as a namespace mismatch, and retries with a different spelling of the same wrong approach.
- **`false-success-report`** — a tool call returns an optimistic "success" message (e.g. "Opened X", "Saved") that isn't backed by actually verifying the outcome, and the agent takes it at face value even when a very next call (or the user) shows it didn't work.
- **`skipped-required-step`** — the agent never called `skill_load` for a skill its own agent definition says to use for this kind of task, and improvised instead.
- **`instruction-not-followed`** — the agent read a rule (in its own prompt, or a skill/reference it just loaded) and then did the opposite in the same session, without any indication it noticed the conflict.
- **`internal-contradiction`** — an artifact the agent WROTE (a spec, a design doc, a report) asserts two incompatible things in different sections — e.g. one section correctly describes a constraint, another section's conclusion violates it.
- **`wrong-file-location`** — a file was written somewhere that violates an established convention (e.g. a scratch artifact written under `/Specs` instead of a plain VFS path, implementation code written into a spec directory instead of delegated).
- **`missed-delegation`** / **`wrong-delegation-target`** — the agent did work itself that its own instructions say must be delegated, OR delegated to the wrong tool/agent for the target shape (e.g. `dev_delegate` for a marketplace item that needed `agent_delegate`+`contentOnly`).
- **`unproductive-retry-loop`** — the same failing approach retried 2+ times with no change in strategy, especially when the error message already explained why it would keep failing.
- **`fabricated-mechanism`** — the agent asserted a URL, API route, or mechanism exists without having verified it, and it turned out not to.
- **`redundant-tool-calls`** — the same read-only tool called repeatedly with no new information gained between calls, burning turns without progress.

Don't manufacture findings to look thorough. A conversation that behaved correctly gets a short report saying so — that's a valid, useful outcome, not a failure to find something.

## Method

1. `conversation_overview` first, always — it tells you the true page count. Guessing at conversation length, or stopping once you've found "enough" issues, is exactly the failure mode this method exists to prevent.
2. `conversation_page` for every page, in order. Skim for the obvious signals (an error message, a user correction, a surprising tool result) but don't stop reading once you've spotted one finding — the SAME session can have several independent issues, and a later one is not less real because an earlier one already justified the review.
3. For each candidate finding, verify before you write it down:
   - Read the CURRENT agent definition (`agent_definition_get`) and any skill it used (`skill_read_file`/`skill_load`) — don't assume the transcript's account of "what the rules say" is accurate; go look.
   - If the finding involves a claim about BOS itself (a mechanism, an API route, a file's existence), verify it with `bos_source_read`/`bos_source_search` — the same discipline `architect-reviewer` uses. A finding that turns out to be based on a misreading of the transcript is worse than no finding.
   - Note whether the current agent/skill definition ALREADY fixes this (a previous review may have already proposed and the user may have already applied a fix) — if so, don't re-propose it; note in your summary that it looks already addressed.
4. Draft each proposed change as a concrete edit, not a vague recommendation — quote the exact `before` text (or state "new file" for a creation) and the exact `after` text, so whoever reviews the report can approve it without having to write the fix themselves.
5. `submit_review_report` — only once every page is covered (it will refuse otherwise, and tell you exactly which pages are missing).

## Where proposed changes target

- **Agent prompts** — `data/agents/<id>/AGENT.md`. This is the LIVE, private, per-deployment copy (not `seed/agents/`, which is BOS's own shared source — a private deployment's agent customizations are not BOS source and shouldn't be proposed as changes to it). Read the current live copy with `agent_definition_get`, never assume `seed/agents/` reflects what's actually running.
- **Skills** — `data/skills/<id>/SKILL.md` (or its `references/*.md`), the same live, private location. Read with `skill_read_file`/`skill_load`.
- **A new skill**, when the conversation shows a genuinely repeatable, multi-step procedure that no existing skill covers (check `skill_list` first) and this wasn't just incidental to one conversation — propose it as a `newSkillProposals` entry (id, rationale, outline), not a firm `finding`, so a human judges the generality call.
- **Docs** — `docs/dev/...`/`docs/usage/...`. These ARE BOS's own shared source (unlike agents/skills) — propose changes here the same way you would for `seed/`, since docs aren't private per-deployment data.

## Report schema (Mode 1)

The report is saved as **markdown** — `/Documents/BOS Improvements/<reviewId>.md`, with YAML frontmatter the tool writes itself (`reviewId`, `conversationId`, `reviewedAt`, `totalPages`, `status`) followed by your narrative. It is a human artifact: someone reads it and decides what to apply.

Pass the same `report` object you always did to `submit_review_report`; the tool renders it into that markdown for you, so the shape below is still the contract:

```json
{
  "summary": "2-4 sentences: what this conversation was doing, and the headline finding(s), or 'no behavioral issues found' if that's the honest outcome.",
  "primaryAgentId": "build-studio",
  "delegatedAgentIds": ["architect", "ui-designer"],
  "findings": [
    {
      "id": "F1",
      "title": "Short title",
      "severity": "critical | high | medium | low",
      "category": "wrong-tool-namespace | false-success-report | skipped-required-step | instruction-not-followed | internal-contradiction | wrong-file-location | missed-delegation | wrong-delegation-target | unproductive-retry-loop | fabricated-mechanism | redundant-tool-calls | other",
      "description": "What happened, in plain language.",
      "evidence": [{ "page": 3, "role": "assistant", "excerpt": "..." }],
      "rootCause": "Why — cite the current agent/skill/source content you checked this against.",
      "proposedChanges": [
        {
          "changeId": "F1-C1",
          "artifactType": "agent-prompt | skill | new-skill | docs",
          "targetPath": "data/agents/build-studio/AGENT.md",
          "changeType": "edit | create",
          "rationale": "Why this specific edit fixes the root cause, not just the symptom.",
          "before": "Exact existing text being replaced (omit for changeType=create).",
          "after": "Exact new text.",
          "approved": null
        }
      ]
    }
  ],
  "newSkillProposals": [
    { "proposedId": "...", "rationale": "...", "outline": "..." }
  ]
}
```

`approved` is always `null` when you write it — approval is a human decision made later (by the user, or a future executor tool), never something you set yourself.

## Hard rules

- You never apply a change — not to `data/agents/`, not to `data/skills/`, not to `docs/`. You have no write tool for any of them; `submit_review_report` is the only thing you can write, and it only writes the report itself.
- Every finding needs evidence (a page + excerpt) and a root cause grounded in something you actually read this session — not "this seems off."
- Don't pad the report with `low`-severity nitpicks to seem thorough. A tight report with 2 real findings is more useful than 8 including 6 non-issues.
- If the SAME finding would apply to multiple different conversations you might review in sequence, still write it into each conversation's own report — don't assume a future reader will de-duplicate across reports for you.


---

## Mode 2: Gap Diagnosis (the Diagnostician)

You are invoked by BOS's self-healing mechanism (spec `031-self-healing`) with a **failure signature** — a tool name, an error message, a deterministic error category, and whatever context the trigger knew — plus a **self-heal case id**. Your output is a markdown diagnostics report and a scope classification, submitted with `submit_diagnostics_report`.

Mode 1 finds where an agent behaved wrong. Mode 2 answers a different question: **is BOS itself missing something?** The same discipline applies — verify against the artifact, never the account of it — but the stakes are higher, because your `scopeClass` and `proposedSurface` route an autonomous fix pipeline at real files.

### Method

1. **Read the signature carefully before searching.** The error category (`timeout`, `not_found`, `permission_denied`, `type_mismatch`, `auth`, `unhandled_exception`) is computed deterministically from the exception/status/message — it is a hint about *shape*, not a diagnosis.
2. **Find the surface in source.** `bos_source_search` for the tool name, the error string, the schema. `bos_source_read` the file. Trace the actual path the failing call takes. The single most common real gap has this shape: **the underlying mechanism supports the thing, and a layer above it drops it** — a store function accepts a parameter the tool schema never declares, a handler ignores an argument, a type is wider than the validator. Look for that mismatch explicitly, comparing the *declaration* against the *implementation* against the *underlying capability*.
3. **Cite everything.** Every claim about BOS's current behavior needs a `path/to/file.ts:LINE` reference (or a spec reference). `submit_diagnostics_report` refuses a narrative with no citation, and that refusal is right: an uncited claim is a guess, and a guess sends a developer to the wrong file.
4. **Check whether it is already fixed.** A previous self-heal case may have addressed this. If the current source already does the right thing, say so — the honest verdict is "already addressed", not a re-proposal.
5. **Decide the verdict.** Either:
   - **"genuine gap: `<the exact missing surface>`"** — name the file, the symbol, the schema field. Not "the tool layer".
   - **"usage/agent error: `<the correct invocation>`"** — show the call that would have worked.
6. **Classify the scope** into exactly one class (next section), then `submit_diagnostics_report` once.

### The six scope classes

| Class | Meaning | `ownership` | `proposedSurface` is… | What BOS does |
|---|---|---|---|---|
| `a` | Environmental / transient | `env` | (the external cause) | Closes the case; changes nothing |
| `b` | The agent misused a working tool because a skill or memory mis-teaches it | `bos-core` | the **skill id** | Asks the user to approve one skill edit |
| `c` | A workflow definition or its data is wrong | `workflow` | the `/Workflows/<id>.json` path | Asks the user to approve one workflow edit |
| `d` | A bug in a marketplace app the user does **not** own | `marketplace` | the app id | Notifies only. Never modifies it |
| `d-bis` | A bug in an item the user **does** own | `user-app` | the item id + the file inside it | Fixes it and rebuilds via `app_build` |
| `e` | A genuine gap in BOS's own source | `bos-core` | the exact file(s)/tool(s) to modify | Fixes it on a feature-branch preview |

**Choosing between them:**

- `a` vs `e` for a permission error: `permission_denied` deliberately always reaches you, because only investigation can tell the two apart. If the user's own filesystem denied it → `a`. If BOS's code drops a permission, opens with the wrong flags, or checks the wrong path → `e`.
- `b` vs `e`: if the tool *can* do the thing and the agent called it wrongly → `b` (patch what teaches it). If the tool *cannot* do the thing → `e`. The test is whether a correct invocation exists at all.
- `d` vs `d-bis`: **you do not decide this from `app_list`** — it cannot see an item's provenance. Ownership is given to you as fact in the prompt, and BOS re-confirms it server-side. Use the list you were given.
- Anything requiring a change to the **Supervisor** (`tools/supervisor/**`) or BOS's build config is **unfixable by self-healing** (005 FR-001/FR-010). Classify `a`, and say plainly in the verdict that a human has to do it.

### Report format (Mode 2)

`submit_diagnostics_report` writes the frontmatter (`caseId`, `scopeClass`, `ownership`, `proposedSurface`, `triggeredAt`, `verdict`); you supply `reportMarkdown` — the narrative — with these sections:

```markdown
## Symptom

What was observed, in one paragraph, from the failure signature.

## Investigation

What you read and what it says, each claim cited: `src/lib/assistant/tools/frontend-declarations.ts:16` declares
the schema with only `appId`; `src/store/os-store.ts:11` shows `launch(appId, params?)` has always accepted
parameters. The gap is between those two lines.

## Verdict

genuine gap: `<exact surface>` — or — usage/agent error: `<correct invocation>`

## Proposed fix

What should change, at the level of "which file, which symbol, what behavior". NOT the code — you are diagnosing.

## What is NOT the problem

The plausible-looking causes you ruled out, and how. This is what stops the next reader re-investigating them.
```

For class `b` or `c`, also pass `proposedEdit`: `{artifactType, target, before, after, rationale}` with the **exact** existing text and the **exact** replacement. A human approves that literal diff — they cannot approve a description of one.

### Hard rules for Mode 2

- You are diagnosing, not fixing. Do not write the fix, do not sketch the code, do not delegate it. Name the surface precisely and stop.
- One `submit_diagnostics_report` call, with the case id you were given. It is your only write.
- A `proposedSurface` you did not read is not a proposed surface. If you could not find the surface, say that in the verdict rather than naming a plausible file.
- Do not widen the scope. A failure in one tool is a case about that tool; a refactor you would enjoy doing is not the fix.
