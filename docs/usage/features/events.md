# Events

BOS apps and background services can raise events — a new email, a
completed workflow run, a health warning, a finished assistant task. The
**bell icon** in the top toolbar shows how many of these you haven't seen
yet, and clicking it opens the **Event Viewer**.

---

## The bell

The number on the bell is your **unread** count (it caps the display at
"99+"). It updates live — no need to refresh. Clicking the bell opens the
Event Viewer.

## Viewing events

By default, the Event Viewer shows your **unread** events, newest first.
Each row shows:

- The source app or service (icon + name)
- A short summary
- The event type and a sequence number (useful when reporting an issue)
- A **processing badge**: a spinner ("processing…") while background
  handlers are still working on it, or a checkmark once they've all finished
- How long ago it happened

Toggle **Show historical** to see events you've already read instead.

### Processing vs. read — two different things

- **Read/unread** is about *you* — has this shown up in your inbox view yet.
- **Processing/processed** is about the *system* — have all the background
  handlers subscribed to this event type finished handling it.

An event can be both "read" and still "processing" (you looked at it, but a
background job triggered by it hasn't finished yet) — the badge updates live
in place when it completes, with no refresh needed.

## Opening an event

Click an event to mark it read. What happens next depends on whether an app
has registered to handle that type of event:

- **One app can handle it (or you've set a default)** — that app opens
  automatically, showing the event's details.
- **Multiple apps can handle it, no default set yet** — you'll see an
  "Open with…" dialog. Pick one, and optionally check **"Always open with
  this app for this event type"** so you're not asked again next time.
- **No app handles it** — the Event Viewer shows its own built-in detail
  view: the full payload as a table, plus the complete processing history
  (which handlers ran, what they returned, and any failures).

## "Mark all as read"

Clears every unread event in one click — the bell drops to zero and
everything moves into the historical view.

## Interpreting processing history

Open an event's detail view (either the built-in one, or any app that shows
it) to see, per handler:

- **Acknowledged** — the handler finished successfully; its result (if any)
  is shown.
- **Failed, retrying** — the handler errored; BOS retries automatically with
  increasing delays (roughly 1 second, then 5 seconds, then a final 30-second
  wait) before giving up.
- **Permanently failed** — the handler errored on all of its attempts. This
  does **not** stop the event from being marked processed — a failure in one
  handler never blocks any other.

## Configuration

The Event Viewer's **Configuration** tab lists every registered handler,
grouped by event type:

- **Headless handlers** (invoked automatically in the background) — toggle
  a handler off to stop it from running (and stop it from holding an event
  in "processing"); the recent-failure count next to it flags a handler
  that's been erroring.
- **UI handlers** (the apps you can open an event with) — set or clear the
  default app used when you click an event of that type, without being
  asked each time.

Disabling and re-enabling a handler is safe: re-enabling it picks back up
any events it hadn't gotten to yet.

## Where does this data come from?

Any BOS app, background service, or the assistant can raise an event — this
is one shared system, not per-app inboxes. Your previous GSuite/Telegram
notifications were carried over into this view automatically the first time
you opened BOS after this feature shipped; nothing was lost.
