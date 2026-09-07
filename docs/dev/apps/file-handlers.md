# File-type handlers & the open-file launch contract

How an app says "I can open files of type X", and what the OS hands it when the
user does. Spec: `user-specs/core-platform/036-file-type-handlers`.

Two halves, and they meet at one convention:

- **You declare** `fileHandlers` in your manifest — see
  [built-in-apps.md](./built-in-apps.md#declaring-file-type-handlers-filehandlers)
  for the field shape (built-ins) and [installed-apps.md](./installed-apps.md)
  for `app.json` (installed apps; the field is identical).
- **The OS launches you** with the file, following the contract below. Honouring
  it is the whole of your obligation as a handler: *when launched with a file,
  read / preview / edit that file.*

---

## What the user does, and what happens

| Gesture in the Files app | Result |
|---|---|
| Double-click a file | Launches the **selected** handler for the file's type with `action: "open"`. No handler → the Files app's own image preview / text editor, unchanged. |
| Right-click a file → "Open with \<App\>" | Launches that handler. A render-capable pick also becomes the type's new selected handler ("always open with"); an edit-only pick is a one-shot with `action: "edit"`. |
| Right-click a directory | Unchanged — handlers apply to files only. |

The **selected** handler must be render-capable and currently installed. If the
user's choice points at an app that has since been uninstalled, the selection
silently expires and the type falls back to the manifest `default`, then to the
Files app's in-app behavior — never a dead window.

---

## The contract

Every handler launch carries these fields:

| Field | Always? | Value |
|---|---|---|
| `path` | yes | The file's VFS path, e.g. `/Documents/report.html` |
| `action` | yes | `"open"` (preview/render) or `"edit"` |
| `url` | only if you declared `paramShape.url: "raw"` | The file's raw-bytes URL, `/api/fs/raw/<path>`. **Built-in handlers only.** |
| `title` | only if you declared `paramShape.title: "basename"` | The file's basename, e.g. `report.html` |

`paramShape` is a **closed vocabulary** the platform interprets uniformly
(`src/os/file-handlers.ts`, `buildLaunchParams`). It exists so the mapping from
"a file was opened" to "the params this particular app wants" is *data in your
manifest* rather than a special case in the Files app — registering a handler
never touches core code.

### Delivery: built-in vs. installed

The fields are the same; how they reach you depends on what kind of app you are,
which is a pre-existing fact of how BOS renders windows, not something this
mechanism chose.

**Built-in (React component)** — they arrive as ordinary launch params:

```tsx
export default function MyViewer({ params }: AppProps) {
  const path = typeof params?.path === "string" ? params.path : "";
  const action = params?.action === "edit" ? "edit" : "open";
  const url = typeof params?.url === "string" ? params.url : ""; // if you declared paramShape.url
  // …render it
}
```

`html-viewer` is the worked example: it declares
`paramShape: { url: "raw", title: "basename" }` and already renders
`params.url` in a sandboxed `<iframe src>` — registering it as the `text/html`
handler took a manifest edit and no component change at all.

The `url` is deliberately the **path-shaped** raw URL
(`/api/fs/raw/Documents/site/index.html`), not the query-shaped one
`fsClient.rawUrl` builds. A browser resolves a document's relative references
against the directory of the URL it was loaded from, and a query string has no
directory: served as `/api/fs/raw?path=…`, a page's `<link href="style.css">`
resolved to `/api/fs/style.css` and 404'd — the page previewed unstyled, or
blank when a relative script built its body. From the path shape the sibling
resolves to `/api/fs/raw/Documents/site/style.css`, which the same route serves.
If you build such a URL yourself, use `rawUrlFor` (`src/os/file-handlers.ts`)
rather than hand-rolling it.

**Installed (iframe)** — an iframe can't be handed a props object, so the fields
ride on the frame's URL as `bos*`-prefixed query params (the same mechanism
`bosEvent*` uses for event handlers). The prefix guarantees they never shadow
query params your app defines itself:

```js
const q = new URLSearchParams(window.location.search);
const path = q.get("bosFilePath");                 // "/Documents/report.html"
const action = q.get("bosFileAction") ?? "open";   // "open" | "edit"
const title = q.get("bosFileTitle");               // if you declared paramShape.title
if (path) { /* fetch the bytes via the BOS SDK, then render or edit */ }
```

An installed app is **never** given a `url`: its iframe `src` is always its own
`manifest.url` (the app's entry page), so it fetches the file's bytes itself
through the SDK's `fs:read` — which means declaring the `fs:read` capability.
Do not declare `paramShape.url` in an `app.json`; it has no effect.

---

## MIME resolution

A file's type comes from its **extension**, via the map in
`src/os/file-handlers.ts` (`mimeForPath` → `fileBaseMime`). There is no content
sniffing. An extension missing from that map resolves to
`application/octet-stream` and therefore matches no handler.

That map is deliberately **not** the larger one in `src/lib/files/serve.ts`
(shared by both shapes of the raw-file route) — that one exists to set
`Content-Type` on streamed bytes (a *serving* concern). So an
extension only present there (`.pdf`, `.mp4`, `.mp3`, …) will **not** match a
handler declaring `application/pdf` or `video/mp4`. If you need it to, add the
extension to the shared matching map in `src/os/file-handlers.ts` — one
client-safe line — rather than reaching for the route's map.

---

## Where the pieces live

| Path | What |
|---|---|
| `src/os/types.ts` | `AppFileHandlerDeclaration`, `AppManifest.fileHandlers` |
| `src/os/file-handlers.ts` | Framework-free & client-safe: the matching MIME map, `baseMime`/`fileBaseMime`, `rawUrlFor`, `buildLaunchParams`, and the wire types |
| `src/app/api/fs/raw/[...path]/route.ts` | The path-shaped raw-file route a previewed document is loaded from (bytes streamed by `src/lib/files/serve.ts`, shared with `/api/fs/raw?path=`) |
| `src/lib/file-handlers/registry.ts` | `server-only`: `handlersFor(mime)`, `effectiveSelected(mime)` — derived per request from the live installed-app set, so an uninstall invalidates by construction |
| `src/lib/file-handlers/selection.ts` | `server-only`: the user's per-type choice, in `data/system/file-handlers.json` |
| `src/app/api/file-handlers/route.ts` | `GET ?mime=` → handlers + selection; `POST {mime, appId?}` → set/clear |
| `src/apps/files/index.tsx` | The consumer: double-click resolution and the "Open with" menu |
| `src/components/apps/IframeApp.tsx` | `withFileParams` — the `bos*` query-param delivery for iframe handlers |

The split is one question: *does it read the installed-app set or durable
state?* Yes → `server-only`. No → the shared client-safe module, because the
client assembles the launch params (`launch` is the client OS store) and cannot
import a `server-only` file.
