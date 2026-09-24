# Repositories

**Settings → Repositories** is everything BrowserOS knows about as a git
repository: the specs it ships with, your own, your apps, and any project you
add yourself.

It answers two questions at a glance, because those are the ones that used to
need a click:

- **What kind of repository is this**, which decides what you can do in it.
- **Does it have work that is not saved or pushed**, which decides whether it is
  safe to walk away from.

---

## The kinds

A repository's **kind** is not cosmetic. It decides where a workflow is chosen
and what "a project" means inside it.

| Kind | A project is | You choose a workflow | Writable |
|---|---|---|---|
| **BOS specs** (`bos-system-specs`) | — | nowhere | no, ever |
| **Your BOS specs** (`user-specs`) | a folder / module | for the **whole store** | yes, on a branch |
| **BrowserOS source** (`bos-src`) | — | nowhere | yes, on a branch |
| **Marketplace** (`user-apps`) | each **item** | **per item** | yes, on a branch |
| **Project** (anything you add) | a folder / module | for the **whole repo** | yes, on a branch |

**BrowserOS source is BrowserOS's own code** — not a spec store, so it binds no
workflow. It is listed because it is a git repository like any other here, and
because "does BrowserOS itself have uncommitted work?" is exactly the kind of
question this page exists to answer without a click. The specs that drive
changes to it live in `user-specs`.

Two of the others read oddly until you see why:

**`user-specs` picks one workflow for everything in it.** It holds refinements
to a single product — BrowserOS — so one pipeline governs all of it. The folders
inside it (`build-studio/`, `assistant/`, …) organise the specs and scope feature
numbering; they are not separate pipelines.

**A marketplace picks a workflow per item.** One repository, many independent
products. Your document-processing app and your terminal app have nothing to do
with each other, so each binds its own.

---

## Adding a repository

**Add repository** offers two routes:

- **Clone existing** — a git URL you already have.
- **Create new** — an empty repository, `git init`-ed here.

Then choose its **kind** and a **workflow**.

### BOS detects a framework you are already using

If the repository already contains an `openspec/` folder, BrowserOS recognises
OpenSpec and preselects it. It is a *preselection*, never a silent decision —
detection can be wrong, and imposing a default over a repo that already uses a
framework would write a second, unrelated spec tree beside the real one.

### A new repository always gets a first commit

An empty repository with no commits is not usable — git operations against an
unborn `HEAD` fail later in ways that look unrelated to the cause. BrowserOS
makes the first commit for you.

### If adding fails, nothing is left behind

A bad URL, an auth failure, an unreachable host — the add fails, says why, and
leaves no half-registered repository. You can correct the URL and try the same
name again immediately.

### Two things BOS refuses

Both put two BrowserOS stores over one working copy, which corrupts branch state
silently:

- **The same repository twice.** Matched by resolved path *and* by remote URL —
  `git@github.com:you/app.git` and `https://github.com/you/app` are the same
  repository spelled two ways.
- **A repository nested inside another** you have already added, in either
  direction.

---

## Where BrowserOS writes inside your project

**This matters most, because it is your source tree.**

**Specs go in a folder the workflow chooses** — `openspec/` for OpenSpec,
`specs/` for spec-kit, `docs/` for BMAD. Not a BrowserOS-specific folder, and
not scattered through your repository. That is deliberate: the framework's own
CLI must keep working on the same checkout, so if you run `openspec validate`
yourself, it finds what BOS wrote.

**Code goes wherever the code goes.** The folder above bounds the *spec store*,
not BrowserOS. Driving a spec pipeline over an application you cannot edit would
be pointless — when you ask BOS to implement something, it edits your source
like any other contributor.

**Everything lands on a feature branch.** Never on `main`, never on your default
branch — including in repositories BrowserOS created. Your repository may have
protected branches and conventions of its own, and work that arrives unbidden on
the default branch is not reviewable. You review and merge, as with any other
contributor.

*Everything* means everything, creating a folder included. Creating a folder used
to be exempt, which produced the worst of both worlds — a stray commit on your
default branch, and then a refusal the moment you tried to put anything in it.

**You do not create the branch yourself.** In Build Studio, just make the edit:
if no branch is active, BrowserOS asks you to name the work and starts one. The
branch is then created in **every repository the change touches** — BrowserOS's
source, the spec stores, and your own repository — under the same name, so one
piece of work is one branch everywhere. That is why there is no "new branch"
button on your repository: naming it is the only part that is yours, and there
is nothing to create by hand.

You can also pick or start one up front, from the **Active feature branch**
selector in the assistant chat.

**Starting a branch works offline.** BrowserOS tries to refresh the base from
your remote first, so the branch starts from current work — but that is a
convenience, not a requirement. If the remote is unreachable, or a credential has
expired, the branch is cut from your local base and the reason is logged. Editing
a spec is a local operation and never depends on the network.

---

## Reading a row

| Badge | Means |
|---|---|
| `clean` | nothing uncommitted, nothing unpushed |
| `N uncommitted` | changed files not yet committed |
| `N unpushed` | commits **no remote has** |
| `read-only` | `bos-system-specs`; BOS's own specs |
| `workflow not installed` | the pack it is bound to is missing (see below) |

Each row also carries **Pull** and **Push**, and a chevron that expands the
repository's **remotes** — each with its own Test / Pull / Push / Edit.

**Row-level Pull and Push act on `origin`.** Cloning registers the URL you gave
as `origin`, along with the branch the clone landed on — the remote's own
default — so a cloned repository always has one. A repository you created here
has no remote until you add one.

If a repository somehow has no `origin` and more than one remote, the row shows
no Pull or Push at all: there is no defensible default, and picking "the first
one" would quietly push somewhere you did not choose. Expand the remotes and use
the buttons on the one you want.

**"Unpushed" is counted against every remote, not against a tracking branch.** A
feature branch that has never been pushed has no upstream — reporting it as
"nothing to push" would be exactly wrong, because that is the work you would lose.

### A repository bound to a workflow you do not have

It still appears, carrying the reason. Its content is intact; BrowserOS simply
cannot interpret it until the method pack is installed. A repository that
silently vanished would read as data loss.

### A broken repository

If a repository's link no longer resolves — you moved or deleted the folder
outside BOS — it shows as **broken**, with the path it expected. It is listed
rather than hidden so the disappearance has an explanation, and you can clean it
up from here.

---

## Removing a repository

There is no single "remove" button, because it would silently be one of these:

- **Forget it** — BrowserOS stops tracking it. **The files stay on disk.**
- **Delete it** — the working copy is removed.

Both take BrowserOS's record of the repository's remotes with them, so adding it
back later starts clean rather than inheriting a stale `origin`. Your git
provider credentials are **not** touched — they live in
**Settings → Integrations → Git Providers** and are shared by every repository.

If the repository has commits no remote has, the dialog says how many before you
choose. **Delete only removes repositories BrowserOS created** for you; one you
already had elsewhere is reached by a link, and is not BOS's to delete — that is
always a forget.

`bos-system-specs`, `user-specs`, `user-apps` and `bos-src` cannot be removed and
are offered no remove action at all. They are BrowserOS's own, and removing any
of them would break the running system. An action that always refuses is worse
than no action.

---

## What is *not* here

**Version control for BrowserOS itself** — previewing, promoting, pinning and
rolling back BOS versions — lives in **Settings → Versions**. It concerns which
build of BrowserOS you are running, not which repositories exist, and keeping
both on one page is what made the old one hard to read.

**Only one marketplace can be written to** (`user-apps`, yours). You can register
any number of marketplaces to install *from*, but authoring happens in your own.

## Related

- [Live version control](../versions/live-version-control.md) — the Versions tab
- [Build Studio](../building-and-modifying/) — authoring specs in these repositories
