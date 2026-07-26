# Settings → Plugins

The **Plugins** tab is where two independent extension systems live side by
side: a pipeline of **plugins** that hook into how the assistant runs, and a
list of installed **services** — background daemons you start once and leave
running.

---

## Plugin Pipeline (left column, top)

Plugins can inspect or modify what happens on every assistant turn: rewrite
messages before the model sees them, add extra system-prompt text, veto a tool
call, or observe what happened after a run finishes. BOS ships two built-in
plugins:

- **Compaction** — compresses long conversation history so it fits the model's
  context window.
- **Memory** — the assistant's long-term memory read/write hooks.

For each plugin you can:

- **Toggle Active/Inactive** — click the badge on its row.
- **Reorder** — drag a plugin's row; pipeline order is execution order (each
  plugin's hooks run in list order).
- **Configure** — select a plugin to see its settings on the right. Fields
  save individually via the **Save** button in that panel (this is the one
  part of this tab that isn't auto-save).

More plugins can be added from the **Marketplace** app if a marketplace
publishes one.

---

## Services (left column, bottom)

Services are background processes — the built-in example is the **Terminal**
service, a small WebSocket daemon that gives you real shell access from a
bundled terminal app. A service shows a colored status dot (running / stopped
/ restarting / crashed / corrupted), its version, and — once bound — the
host:port it's listening on.

Each service card has five actions:

| Icon | Action |
|---|---|
| ▶ | **Start** |
| ■ | **Stop** |
| ↻ | **Restart** |
| ⚙ | **Config** — open its settings in the right-hand panel |
| 📄 | **Logs** — view its recent stdout/stderr |
| ↗ | **Open App** — opens the service's bundled UI in a new tab (only present if the service ships one — the Terminal service does) |

### Configuring a service

Click the gear icon to open its config panel. Fields shown come from the
service's own schema (for Terminal: port, host, shell). **Changes save
automatically as you edit** — there's no Save button — but they only take
effect the next time you **Restart** the service. If a service's config came
from a read-only marketplace source, the fields are shown but disabled.

### Viewing logs

Click the log icon to see the service's captured stdout/stderr in the
right-hand panel — useful for figuring out why a service won't start or keeps
crashing.

### Crash recovery

If a service crashes, BOS restarts it automatically with an increasing delay
(1s, 2s, 4s, 8s, 16s) up to 5 attempts, then leaves it stopped and shows a
restart count on its card. Manually restarting resets that counter.

---

## Try it: the Terminal service

BOS ships a Terminal service + app out of the box so there's something to try
immediately, without a marketplace:

1. Open **Settings → Plugins**. Under **Services**, find **Terminal Service**.
2. Click **Start** (▶). Its status dot turns green once it's bound to a port.
3. Click the **Open App** icon (↗). A new tab opens with a simple terminal —
   type a command and press Enter to run it in a real shell on the machine
   hosting BOS.
4. When you're done, go back to Settings and click **Stop** (■).

> **Security note:** the Terminal service gives whoever can reach it real
> shell access on the host. Only start it if you understand and accept that.
