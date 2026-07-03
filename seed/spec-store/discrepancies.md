# Discrepancies — where code diverges from the specs

Living notes on where the implementation currently differs from the written specs.
Keep entries short; link the authoritative spec.

## Per-conversation agent (supersedes "global active agent")

Specs `011`, `012`, and `016` describe a **global active agent** (e.g. "the active
agent's allowed tools", "regardless of the globally active agent"). The
implementation has **no global active-agent state**: each conversation carries its
own `agentId`, and `composeInstructions(agentId)` throws on an empty id rather than
falling back. `DEFAULT_AGENT_ID = "assistant"` survives only for delete-protection
and blank/bootstrap seeding. Authoritative: `019-tools-and-sandbox` FR-003/FR-004.
The "active agent" phrasing in `011`/`012`/`016` should be read as "this
conversation's agent."

## Capability registry context enum

`016` FR-003 describes contexts as `client` and/or `server`. The implemented
`capabilities-registry.ts` uses a single `context: "action" | "tool" | "both"`
field (action = client, tool = server, both = both surfaces). Semantically
equivalent; naming differs. Authoritative: `019` FR-001.

## Sandboxed `run_command` replaces `runBash`

Earlier specs assumed an unsandboxed `runBash`. It is replaced by `run_command`
(docker/local backends, off by default, VFS-backed `/workspace`). Authoritative:
`019` FR-006..FR-009. Dev doc: `docs/dev/run-command/run-command.md`.

## GEPA is "GEPA-lite"

`003-self-improvement` `skill_improve` is a single reflective rewrite recording a
self-reported score, not the full GEPA loop (candidate generation + evaluation +
Pareto selection + versioned rollback). See `003-self-improvement`.
