# GSuite (Google Workspace)

The **GSuite integration** connects BrowserOS to your Google account so the
assistant can work with your **Gmail**, **Drive**, **Calendar**, and **Contacts**
alongside everything else it does in the OS. Ask *"any new invoices in my
inbox this week?"* or *"find the pitch deck Alice shared last month and export
it as a PDF"* and the assistant reaches into Google on your behalf.

You are in control of what BOS can see: the integration is **off** until you
upload OAuth credentials and connect, and every scope is **individually
grantable** and revocable from Settings.

---

## Overview

Once connected, GSuite adds four **services** the assistant can call:

| Service     | What the assistant can do today                                                                 | Status |
|-------------|--------------------------------------------------------------------------------------------------|--------|
| **Gmail**   | List / search / read messages, send + reply, add/remove labels, trash/untrash, list labels.     | Full   |
| **Drive**   | List, search, download, and export files (Docs → PDF, Sheets → CSV, …).                          | Read-only (write in a future release) |
| **Calendar** | Service surfaces in the UI; the "reminder poll" hook is in place but returns nothing yet.       | Coming — write & event listing land in a later phase |
| **Contacts** | Service surfaces in the UI so scopes can be granted ahead of time.                              | Coming — People API adapter lands in a later phase |

On top of the on-demand tools, Gmail can also **push** into BOS:

- **Polling** — a background scheduler asks Gmail for new messages on an interval
  and drops each new email into the **Notifications** inbox.
- **Webhooks (Google Cloud Pub/Sub push)** — Google calls BOS the moment
  something changes, no polling required.

Notifications from both mechanisms appear as unread items on the Dock badge and
are visible to the assistant, so you can say *"summarize what came in overnight."*

---

## Prerequisites

To connect Gmail/Drive/Calendar/Contacts you need three things from Google:

1. **A Google Cloud project.** Any Google account can create one for free.
2. **The Google APIs you want to use, enabled** on that project — at minimum
   the **Gmail API** and **Google Drive API**; also **Google Calendar API**
   and **People API** if you plan to grant those scopes later.
3. **An OAuth 2.0 Client ID** (Application type: **Web application**) with a
   `client_secrets.json` you can download.

That's it — no Cloud billing is required for the OAuth flow itself.
Webhook push (Gmail Pub/Sub) does need a small amount of Cloud setup; see
[Gmail webhook (Pub/Sub) push](#gmail-webhook-pubsub-push) below.

**Where GSuite settings live in BOS:** open **Settings → Integrations → GSuite**.
This page is the entire lifecycle: upload credentials, connect, pick scopes,
configure per-service options, disconnect.

[Screenshot: Settings → Integrations list showing GSuite with the "Not connected" indicator]

---

## Setup guide

### 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Click the project picker at the top of the page and choose **New project**.
3. Give it any name (e.g. `browseros-personal`) and create it.

[Screenshot: Google Cloud Console — New project dialog]

### 2. Enable the APIs you need

In the Cloud Console, open **APIs & Services → Library** and enable, at minimum:

- **Gmail API**
- **Google Drive API**

Enable these too if you plan to use them:

- **Google Calendar API**
- **People API** (used for Contacts)

You only need to enable an API once per project.

[Screenshot: APIs & Services → Library with Gmail API selected]

### 3. Configure the OAuth consent screen

If this is your first OAuth client in the project, Cloud Console will ask you to
configure the **consent screen**:

- **User type:** *External* is fine for personal use.
- **App name / support email / developer email:** put anything sensible.
- **Scopes:** you don't need to add anything here — BOS requests scopes at
  connect time. Skip.
- **Test users:** while the app is in **Testing** mode (the default), add your
  own Google account as a test user. Otherwise Google blocks the login with an
  "access blocked" screen.

You do **not** need to publish the app or go through Google's verification
process for personal use.

[Screenshot: OAuth consent screen — Testing status with your account listed as a test user]

### 4. Create an OAuth 2.0 Client ID

1. Go to **APIs & Services → Credentials → + Create credentials → OAuth client
   ID**.
2. **Application type:** **Web application**.
3. **Name:** anything (e.g. `BrowserOS`).
4. **Authorized redirect URIs:** add the callback URL your BOS instance uses.
   The default when running locally is:

   ```
   http://localhost:3000/api/integrations/oauth/callback
   ```

   If BOS is reachable at a different host or port, use that host + the same
   `/api/integrations/oauth/callback` path. The redirect must match **exactly**
   — trailing slashes count.
5. Click **Create**, then **Download JSON** — this is your
   `client_secrets.json`.

[Screenshot: Create OAuth Client ID form with Web application selected and the redirect URI filled in]

### 5. Upload `client_secrets.json` to BrowserOS

1. In BOS open **Settings → Integrations → GSuite**.
2. When no credentials are on file, the page shows a **drag-and-drop uploader**
   at the top. Drop your `client_secrets.json` on it, or click **Choose file**
   and pick it manually.
3. BOS validates the file, encrypts it, and stores it in the app's server-side
   secrets store — the raw file is never committed to your repo and never
   exposed back to the browser.

BOS accepts both shapes Google emits (`web` and `installed`); if both are
present the `web` block is used.

[Screenshot: GSuite detail page with the "Upload client_secrets.json" drop zone]

### 6. Connect

Once the credentials are uploaded, a **Connect** button appears. Click it and:

1. BOS opens a Google sign-in popup.
2. Pick the Google account you want to use.
3. Google shows the consent screen listing the scopes BOS is asking for.
4. On success the popup closes and the page updates to **Connected**, showing
   the email address you signed in with.

[Screenshot: Detail page after connect — green dot, "Connected as you@example.com", Reauthorize/Disconnect buttons]

You can **Reauthorize** any time to change which scopes have been granted (for
example, to add `gmail.send` later without disconnecting first) and
**Disconnect** to clear all stored tokens.

---

## Service configuration

Each service has its own drill-down page reached from the GSuite detail view.
Every page has the same shape:

- An **Enable** toggle — turning a service off keeps your OAuth tokens on file
  but blocks every method the assistant might call on it.
- **Scopes** — per-scope toggles that respect what Google actually granted. A
  scope you never granted on Google can't be enabled here; a scope you granted
  can be turned off locally to keep credentials but withdraw access from the
  assistant.
- **Polling** and **Webhooks** — only shown for services whose adapter supports
  them. Gmail supports both; Drive supports neither today.

### Gmail

**Scopes (choose only what you need):**

| Scope                                             | Grants                             | Assistant methods it unlocks                                    |
|---------------------------------------------------|------------------------------------|-----------------------------------------------------------------|
| `https://www.googleapis.com/auth/gmail.readonly`  | Read messages, labels, profile.    | `listMessages`, `getMessage`, `searchMessages`, `listLabels`, `getLabel`, `getProfile` |
| `https://www.googleapis.com/auth/gmail.modify`    | Add/remove labels, trash/untrash.  | `modifyMessage`, `trashMessage`, `untrashMessage`               |
| `https://www.googleapis.com/auth/gmail.send`      | Send new mail, reply in-thread.    | `sendMessage`, `replyToMessage`                                 |

Grant the narrowest scope that covers what you want the assistant to do. Read-only
is a safe default; add `modify` if you want the assistant to organize your
inbox, add `send` only if you want it to write mail on your behalf.

#### Gmail polling

Open **GSuite → Gmail → Polling**:

- **Enable automatic polling** — the background scheduler daemon calls Gmail for
  you on the interval you pick.
- **Interval** — pre-set values from 30 seconds to 30 minutes (5 minutes is the
  default and a good starting point). The daemon respects Gmail's rate limits
  and backs off automatically on errors.
- **Poll now** — one-shot poll from the UI. Handy for testing.

Every new message the poll finds is emitted as a `new_email` **integration
event** and appended to the notifications inbox — the Dock badge counter goes
up and the assistant can see the event when you ask it about "recent emails".

The section also shows **live status** — last attempt, last success, next
eligible time, current backoff, and how many failures in a row — pulled from
`GET /api/integrations/scheduler` every few seconds.

[Screenshot: Gmail polling section with "Enable automatic polling" on, interval 5 minutes, and live status]

#### Gmail webhook (Pub/Sub) push

Push is faster than polling but needs a bit of Google Cloud plumbing. You'll
need:

1. A **Pub/Sub topic** in your Cloud project (`projects/<id>/topics/<name>`).
2. A **push subscription** on that topic whose **push endpoint** is the
   **Receiver URL** shown in the Webhooks section of BOS. Google authenticates
   push requests with an OIDC JWT — during subscription creation set the
   **Audience** to the same string you enter into the BOS "Audience" field,
   and pick the service-account whose email you enter into "Push service
   account".
3. Grant the Gmail service account (`gmail-api-push@system.gserviceaccount.com`)
   permission to publish to your topic.

Then in **GSuite → Gmail → Webhooks**:

1. Fill in **Topic name** (the full `projects/<id>/topics/<name>` path),
   **Audience**, **Push service account**, and **Label IDs** (default
   `INBOX`).
2. Click **Enable**. BOS calls `gmail.users.watch()` for you to start the push.
3. **Copy** the Receiver URL and paste it into your Pub/Sub push subscription.
4. Optionally **Rotate secret** — an HMAC secret used to verify requests. The
   value is shown **once** on rotation; copy it immediately.
5. **Test** drops a synthetic event straight into the notifications inbox so
   you can verify BOS → UI wiring without waiting for real mail.

Every Google push translates into a `new_email_history` event carrying the
Gmail `historyId`; the assistant (or a follow-up poll) can then diff against
`gmail.users.history.list` to pick up the actual messages.

[Screenshot: Gmail webhook section with Enabled badge, receiver URL, Pub/Sub fields, and Rotate secret button]

### Drive

Drive today is **read-only**. Uploading, patching, deleting, and moving files
are planned for a later release.

#### Drive access levels — pick one

| Scope                                              | Meaning                                                                                              | When to choose it                                                    |
|----------------------------------------------------|-------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| `https://www.googleapis.com/auth/drive.readonly`   | See **every** file in your Drive. Broader, but the assistant can list/search anything.               | You want the assistant to browse your whole Drive on request.       |
| `https://www.googleapis.com/auth/drive.file`       | Access **only** files this app opens or creates. Safer, but you must open a file explicitly first.   | You want strict, per-file consent — you'll open files from Google before asking. |

You can toggle scopes off later without disconnecting.

Beyond the scopes, Drive's config page exposes:

- **Root folder id** — optional; browse only inside this folder. Leave empty to
  use your Drive root.
- **MIME type filter** — narrow what the browser lists.
- **Mount Drive in Files app** — reserved for a future release; currently a
  no-op.

The assistant methods Drive exposes:

- `listFiles`, `searchFiles`, `getFile`, `listFolders`, `getAbout`
- `downloadFile` — returns base64 content up to 256 KB (larger files come back
  as `{ error: "too_large", size }` so the assistant can decide what to do).
- `exportFile` — Google-native docs (Docs / Sheets / Slides) to another MIME
  type: `application/pdf`, `text/csv`, `text/plain`, `text/html`, …

[Screenshot: Drive service config with the "Drive access levels" explainer and the two scope toggles]

### Calendar

The Calendar service surfaces in the UI so its scopes can be granted alongside
Gmail/Drive, but the adapter is a **placeholder**. Today it exposes only a
`pollUpcomingReminders()` hook that always returns `[]`; listing events and
creating/updating/deleting them are coming in a later phase and will throw a
"not yet implemented" error if the assistant tries to call them.

You can already configure:

- **Calendar id** — `primary` or a specific calendar id.
- **Reminder minutes before** — how many minutes before an event to notify.
- **Max upcoming events to track.**

Grant `calendar.readonly` and/or `calendar.events` now if you want the scopes
pre-authorized for when the adapter ships.

### Contacts

Same shape as Calendar — the service is declared and its scope
(`contacts.readonly`) can be granted, but the People API adapter is not yet
implemented. Any invocation returns a config error the assistant can reason
about ("Contacts.listContacts is not yet implemented").

---

## Using the integration

### From the assistant

You don't call the tools by name — just ask for what you want. The assistant
picks the right method based on the tool descriptions. Example prompts that
already work today:

**Gmail (readonly):**

- *"Any unread emails from Alice this week?"*
- *"Summarize the newest 5 emails in my inbox."*
- *"Search my mail for 'invoice' from the last 30 days and list totals."*

**Gmail (modify):**

- *"Star the last email from my boss and mark it as read."*
- *"Move that promo from Nike to Trash."*

**Gmail (send):**

- *"Reply to the latest email from Bob saying I'll get back to him tomorrow."*
- *"Send an email to team@example.com titled 'Weekly update' with the summary above."*

**Drive:**

- *"Find the pitch deck Alice shared last month."*
- *"Export the 'Q3 forecast' Google Sheet as CSV and save the result to my files."*
- *"Download the PDF called 'invoice-042' and read the total to me."*

### Notifications from polling and webhooks

Both Gmail polling and the Pub/Sub push write into the same **notifications
inbox** (`data/integrations/notifications.json`). Two shapes you'll see:

- `new_email` — emitted by polling, carries the actual Gmail message id.
- `new_email_history` — emitted by webhooks, carries a `historyId` the
  assistant can diff against `gmail.users.history.list` to fetch the new
  message ids.

Unread notifications increment the Dock badge. Ask the assistant *"what came
in?"* or *"anything new in Gmail?"* and it will read the inbox and mark items
read once you've dealt with them.

---

## Security notes

- Your `client_secrets.json` is **encrypted at rest** in the BOS server-side
  secrets store. It is never returned to the browser and is not committed to
  your repo (`data/` is gitignored).
- OAuth **access and refresh tokens** are stored the same way and are never
  logged. They are cleared instantly on **Disconnect**.
- **Scopes are additive but revocable.** Granting a scope on Google's consent
  screen lets BOS request it; disabling that scope in **Settings → Integrations
  → GSuite → <service> → Scopes** keeps the token but blocks BOS from using it.
  For a full revoke, disconnect or remove the app under
  <https://myaccount.google.com/permissions>.
- Webhook receivers verify **Google-signed OIDC tokens** (via the tokeninfo
  endpoint) and, if you set them, the expected **audience** and **push service
  account** — random senders can't inject events into your inbox.
- The webhook HMAC **secret** is shown exactly once on rotation. If you lose
  it, rotate a new one; the old one still verifies during a short rotation
  window so you don't drop events mid-cutover.

---

## Troubleshooting

**"Access blocked: has not completed the Google verification process"** —
your OAuth client is in **Testing** mode and the signed-in Google account
isn't on the **Test users** list. Add it under **APIs & Services → OAuth
consent screen → Test users**.

**"redirect_uri_mismatch"** — the redirect URI Google is sending back doesn't
match any of the ones you registered on the OAuth client. Copy the URL from
the error page verbatim (mind the port, `http` vs `https`, and trailing
slashes) into the client's **Authorized redirect URIs** and try again.

**"Popup was blocked. Allow popups for this site and try again."** — your
browser blocked the OAuth window. Allow popups for the BOS origin.

**Uploader says "client_secrets.json (web) missing required fields: …"** — the
file you dropped isn't a Google **OAuth 2.0 Web application** client_secrets
file. Re-download it from **APIs & Services → Credentials**; do not paste an
API key or service-account JSON.

**Connected but Gmail tools all fail with "insufficient authentication
scopes"** — you connected before the scope was toggled on, or you disabled it
locally. Click **Reauthorize** and tick the scope on the Google consent
screen; then re-enable it in **Settings → Integrations → GSuite → Gmail →
Scopes**.

**Polling shows "backoff until … (600s wait)"** — Gmail returned a rate-limit
or transient error and the scheduler is holding off. This is normal; the next
attempt runs automatically when the timer expires. If failures pile up,
inspect **Last error** below the status grid.

**Webhook receiver returns 401** — the audience on the Google push
subscription doesn't match the **Audience** field in BOS, or the push service
account differs from what you configured. Update either side so they match.

**Test button reports success but the Dock badge doesn't move** — dismiss the
existing notifications and try again; only **unread** items count toward the
badge.

**Drive `downloadFile` returns `{ "error": "too_large", "size": … }`** — the
file exceeds the default 256 KB cap. Ask the assistant to `exportFile` (for
Google-native docs) or increase `maxBytes` in the request.

**Calendar / Contacts throw "not yet implemented (Phase 4)"** — expected;
those adapters ship in a later phase. Only the manifest surfaces exist today.

---

## FAQ

**Do I need a billing-enabled Google Cloud project?**
No. Free-tier is enough for the OAuth flow and both Gmail and Drive API calls.
Pub/Sub push has a generous free tier but does require enabling the Pub/Sub
API in a project.

**Can I connect more than one Google account?**
Not today. GSuite is a single connection per BOS instance. Reauthorize to
switch accounts (or use a separate BOS profile).

**Where are my tokens stored?**
Under the BOS data directory in the integrations secrets store, encrypted at
rest. See the developer docs for the exact layout.

**Can I use the integration from the Files app or other built-in apps?**
Today, Drive-in-Files is a stub (the config flag is a no-op). The intended
surface today is **through the assistant** — ask it to search, download, or
export.

**Can I disable a service without disconnecting?**
Yes — turn off the service's **Enable** toggle. Tokens stay, but every method
call is refused server-side.

**Can I keep the OAuth client between BOS installs?**
Yes — the `client_secrets.json` is a per-project Google artifact, unrelated
to BOS. Save it somewhere safe and re-upload on a new install.

**How do I completely revoke BOS?**
Click **Disconnect** in BOS to clear stored tokens, then remove the app under
<https://myaccount.google.com/permissions> to invalidate any refresh tokens
still in Google's records.

**Will Drive write / Calendar / Contacts show up automatically when they ship?**
Yes — the manifest already lists them, so an updated BOS release will light
those methods up without another OAuth trip provided the scopes are already
granted.
