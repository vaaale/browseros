# Assistant API routes

Server endpoints behind the assistant subsystem. See the full table in
[API reference](../../api-reference.md).

---

## Chat runtime

| Route | Methods | Purpose |
|---|---|---|
| `/api/copilotkit` | POST | CopilotKit runtime endpoint. Builds the runtime + provider adapter **per request** (Anthropic → `AnthropicAdapter` with prompt caching; OpenAI family → `OpenAIChatAdapter` via the in‑app proxy). Wires MCP servers via `buildRuntimeOptions`. |
| `/api/llm/openai/[...path]` | POST (proxy) | OpenAI normalization proxy: forces **Chat Completions** (not Responses), injects `max_tokens`, surfaces `reasoning_content` as `<think>…</think>`. Keeps the real key server‑side. |

---

## Provider

| Route | Methods | Purpose |
|---|---|---|
| `/api/agent/provider` | GET, PATCH | Read / update AI provider config. Key **masked** (GET returns `hasApiKey`, not the key). |
| `/api/agent/provider/test` | POST | Test the provider connection. |

---

## Agents & personality

| Route | Methods | Purpose |
|---|---|---|
| `/api/assistant/agent` | GET, PATCH, POST | GET → agents + the **composed** instructions; PATCH → set the active agent; POST → create an agent. |
| `/api/assistant/title` | POST | Generate a short conversation title from the first exchange (isolated `complete()`, `maxTokens:256`, sanitized; never enters the chat). Returns 503 if no provider. |
| `/api/subagents` | GET, POST, DELETE | Sub‑agent registry. |
| `/api/subagents/delegate` | POST (NDJSON stream) | Run a sub‑agent, streaming `{type:"tool"}` events then `{type:"done"\|"error"}`. |

---

## Memory, skills, learning

| Route | Methods | Purpose |
|---|---|---|
| `/api/memory` | GET, POST, DELETE | GET → `{ user, memory }` entries; POST `{ target, action, content }`; DELETE `?target=&text=`. |
| `/api/skills` | GET (list / `?id=`), POST, DELETE | Skill CRUD (+ scripts/references; `previousId` to rename). |
| `/api/skills/improve` | POST | GEPA‑lite skill improvement from feedback. |
| `/api/skills/curator` | POST | Run the Curator (archive stale agent‑created skills). |
| `/api/assistant/reflect` | POST | The self‑improvement review pass over a transcript. |

See [Memory](../../memory/memory.md) and
[Self‑improvement](../../self-improvement/self-improvement.md).

---

## Notes

- All of these are server routes; clients reach them via `fetch` from action
  handlers or app components.
- The **provider key is never returned** — treat `data/provider.json` as a secret;
  GET responses expose only whether a key is set.
- `/api/subagents/delegate` and the workflow run route stream **NDJSON**; consumers
  read line‑delimited JSON, not a single body.
