# The Marketplace app (`src/apps/marketplace/`)

The built-in app for browsing every source of installable content, installing
items from them, and adopting specs. It is a thin client: it renders whatever
`GET /api/marketplace` returns and posts operations back to the same route. It
never touches the filesystem and never sees a path — which is why the 034/035
layout changes (items moving under `items/`, install becoming a single symlink)
required no functional change to it at all.

Specs: `028-marketplace-sandbox` (item semantics, sandboxing, and the UI
requirements UI-001…UI-006), `034-user-apps-marketplace-parity` (the local
`user-apps` slot as one source among equals), `035-install-by-symlink` (what
installing does).

---

## Master-detail layout

```
┌──────────────┬──────────────────────────────────────────────┐
│ SOURCES      │  Add marketplace by git URL         [Add]    │
│              │  Filter items…                               │
│ All      12  │ ┌──────────────────────────────────────────┐ │
│ ─────────    │ │ ▼ My Apps            (local) …      3  ⋯ │ │
│ My Apps   3  │ │   [item] [item] [item]                   │ │
│ BOS Mkt   8  │ ├──────────────────────────────────────────┤ │
│ Skills !  1  │ │ ▶ BrowserOS Marketplace  https://…  8  ⋯ │ │
└──────────────┴──────────────────────────────────────────────┘
        master                        detail
```

**Master (`<aside>`)** — an **All** entry followed by one entry per source, in the
order the API returns them (the local slot comes first). Each row shows the number
of items currently matching, marks a source whose manifest failed to parse with a
`!`, and tags the user's own slot as `(yours)`. Rendered by the `SidebarEntry`
component at the bottom of the file.

**Detail** — the "add a marketplace" field, the text filter, error/notice banners,
then one `<section>` per source exactly as before, except each is now collapsible.

---

## The two filters compose

There are two independent filters, and one rule that matters:

```ts
const byRepo = catalog.map((mk) => ({ mk, items: q ? mk.items.filter(...) : mk.items }));
const shown  = byRepo.filter(({ mk }) => selectedRepo === null || mk.id === selectedRepo);
const totalMatches = byRepo.reduce((n, r) => n + r.items.length, 0);
```

The text query is applied **once**, per source, into `byRepo`. The sidebar counts
and the detail view both derive from that single result. Computing the counts
separately would let the sidebar claim a number the detail view doesn't show —
the same class of drift as two registries scanning the same directory
independently (see [design heuristics](../design-heuristics.md)).

`selectedRepo === null` means **All**. Only the repo filter is a *selection*; the
text query never changes which sources are listed, only their counts and contents.

---

## Collapse behaviour

Collapsed sources live in a `Set<string>` — **expanded is the default**, so a new
source appears open rather than hidden.

- The section header *is* the toggle (`aria-expanded` reflects state).
- The Sync/Remove actions sit inside the header, so their container calls
  `stopPropagation()` — otherwise syncing a marketplace would also fold it.
- The header, its actions and any manifest error stay visible while collapsed;
  only the item grid unmounts.
- **Selecting a collapsed source expands it** (`selectRepo`). Selecting something
  and landing on an empty-looking pane would be a dead end.

---

## What the app knows about installing

Almost nothing, deliberately:

- **One item, one click.** An item is a single thing even when it bundles several
  facets (the Terminal item ships both an app and a service), so `installItem()`
  installs every facet the item offers in one operation. Adopting a spec stays
  separate — it forks a copy for editing rather than installing anything. That's
  distinct from an installed item's `spec/` facet showing up **in place** as its
  own store in Build Studio (`src/lib/specs/item-stores.ts`) — adopting makes a
  disconnected copy to build on top of; the in-place store is the live spec that
  documents this exact installed item, editable only when the item is local. This
  is also how a marketplace item's spec is *authored* in the first place — Build
  Studio's `specify` step calls `installItem()` (via `createItemSpec()`/
  `app_spec_create`) with just a `spec/spec.md` file, bringing the item into
  existence — symlinked, git-committed — before any app/service/plugin code
  exists at all.
- **Every facet is installable, including the ones with no UI.** `voiceEngine`,
  `integration` and `serverPlugin` count via `hasPluginFacet()`. Leaving them out
  is what made Live Avatar unable to be installed at all once it stopped shipping
  an `app` facet: the item was real, active and invisible to the one screen that
  could install it.
- **Installed state comes from elsewhere.** The app cross-references the OS store
  (`useOSStore(s => s.apps)`), `/api/skills` and `/api/services`, plus
  `installedItemIds` from `GET /api/marketplace` — the 035 shared scan, and the
  only answer that works for a facet with no registry of its own (a plugin). It
  rides *alongside* the catalog rather than as a field on `MarketplaceItem`,
  because that type is the manifest's own schema and gets written back to disk.
  App ids *are* item ids, so every comparison is a plain id match.
- **Uninstall is one op too.** `uninstall-item` removes whatever the item
  installed, dispatching on the facets that are actually INSTALLED (from the scan)
  rather than on what the manifest currently claims — so it still works after the
  marketplace it came from was removed, or after a facet stopped being declared
  while remaining installed here.
- **`LOCAL_MARKETPLACE_ID = "user-apps"`** is duplicated as a client-side constant
  (the client cannot import `server-only` code). It keys the local **slot by
  location**, not the repo's identity — the section title and the sidebar label
  come from that repo's own `marketplace.json`, so a `user-apps` pointed at a
  published marketplace shows that marketplace's name. The only behavioural
  branches on it are the button label ("Rescan" vs "Sync") and hiding "Remove".

---

## Tests

`e2e/036-marketplace-master-detail.spec.ts` covers the sidebar contents and
counts, source filtering, All clearing the filter, collapse/expand from the
header, and the two filters composing. It stubs `GET /api/marketplace` so the
assertions are about UI behaviour rather than whatever marketplaces happen to be
registered in the dev data directory.

One gotcha when writing locators here: a source's name appears **twice** on
screen — once as a sidebar entry, once as its section header — so sidebar
assertions must be scoped (`page.locator("aside")`) or Playwright's strict mode
fails on the ambiguity.
