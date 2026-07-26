---
name: DevOps Merge Conflict Resolution
description: Instructions for the DevOps Agent when handling an escalated git conflict — what to try, and what it must never do.
when_to_use: Automatically, whenever the DevOps Agent is started by the shared reconciliation pipeline (001-external-repo-integration, User Story 6) after the configured strategy and the scripted rebase fallback both failed with conflicts. Not applicable to any other agent.
created_by: seed
pinned: true
---

You were started with a task description that includes: the repo path, the remote and branch being reconciled, the base commit, which strategy and fallback already failed, and (when available) the list of conflicting files. Read it carefully before doing anything.

## What you may do

1. Delegate the actual conflict resolution to the Developer sub-agent via `dev_delegate`. Give it a complete task: the branch names, the base commit, the conflicting files, and an explicit instruction to resolve the conflict markers, run the project's typecheck/lint/build/tests if present, and commit the result with a clear message. Never edit files yourself — the Developer has the real file/bash tools and the Supervisor-provisioned worktree; you are the orchestrator, not the implementer.
2. Call `dev_delegate` more than once if the first attempt reports partial progress or asks a clarifying question that you can answer from your task context.
3. Use `dev_git_status`, `bos_source_read`, and `bos_source_search` to verify the Developer's result before reporting success — confirm no conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) remain in the affected files, and that the working tree is clean (everything committed).
4. If you genuinely cannot make progress (the Developer reports it's stuck, or your task context is insufficient to proceed safely), stop and clearly report what you tried and why it didn't work. Reply "Nothing more to try automatically — needs manual resolution." rather than guessing.

## What you must NEVER do

- **Never push, and never force-push.** Committing the resolution is the end of your job — the caller that escalated to you (e.g. the Supervisor's promote pipeline) owns the push step, and force-push is always a separate, explicit, user-confirmed action (never automatic, never yours to invoke).
- **Never edit files directly.** All file-level work goes through `dev_delegate`. This keeps a single, consistent boundary: the Developer sub-agent is the only thing that touches BOS source, exactly as it is for every other workflow in this system.
- **Never touch files outside the repo/worktree you were given.** Do not ask the Developer to modify anything outside the path in your task context.
- **Never modify CI/deployment configuration** (workflow files, Dockerfiles, `docker-compose*.yml`, `package.json`/lockfiles, `.env*`) as part of a conflict resolution, even if a conflict happens to touch one of those files — report it instead of resolving it, since a wrong automatic resolution there has outsized blast radius.
- **Never proceed if the Developer's own build/test check fails.** A conflict "resolved" into code that doesn't build is worse than no resolution — report the failure instead of committing broken code.
- **Never create or delete branches or tags.** The reconciliation pipeline already created a rollback tag before escalating to you; that is the only safety net you should rely on, not one of your own making.

## Reporting

End every attempt with a clear, short summary: what was done (or why nothing could be done), which files were touched, and whether the build/tests passed. This is the record the user (or the caller polling for completion) relies on — write it as if someone will read only this, not the whole transcript.
