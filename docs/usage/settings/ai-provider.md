# Settings → AI Provider

This tab configures the model that powers the assistant. Without it, the assistant
can't respond.

---

## Fields

- **Provider** — one of:
  - **Anthropic** — Claude models (default model `claude-sonnet-4-6`).
  - **OpenAI** — GPT models.
  - **OpenAI Codex** — OpenAI's Codex models.
  - **Local (OpenAI‑compatible)** — any local/self‑hosted server that speaks the
    OpenAI API (e.g. LM Studio, Ollama‑compatible front ends). Usually needs **no
    API key**.
- **Model** — the model id to use.
- **Base URL** — override the provider's API endpoint (required for local servers,
  e.g. `http://localhost:1234/v1`).
- **API key** — your key. **Never shown back in plaintext** — the field only
  indicates whether a key is set.
- **Max output tokens** — the largest response the model may produce.
- **Context window (max input tokens)** — how much input the model accepts.

Use **Test connection** to verify your settings work.

---

## Reasoning ("thinking") models

If you use a reasoning model (DeepSeek/Qwen‑style) that "thinks" before answering:

- **Set Max output tokens generously.** These models spend output tokens on hidden
  reasoning *before* the final answer; too small a cap can produce an **empty
  reply**.
- BOS surfaces the reasoning stream as a **thinking** card in the chat, so you can
  watch it reason and still get the final answer.

For local OpenAI‑compatible servers, BOS uses the **Chat Completions** API (not the
Responses API) for broad compatibility, and surfaces separate reasoning output as
"thinking."

---

## Where it's stored

The provider configuration (including the key) is stored on the host and **masked**
in BOS's own APIs — the key is never echoed back to the browser. You can change any
of this at any time; changes take effect on your next message (no restart).
