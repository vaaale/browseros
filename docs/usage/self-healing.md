# Self-healing

BrowserOS can notice when something in *itself* is broken, work out what,
and build you a fix.

It is not magic and it is not automatic all the way through. The loop is:

**something fails → a Diagnostician investigates BOS's own source → if it is a
real gap, a fix is built on a preview → you get told → you decide.**

BrowserOS never installs a fix for you. It builds one and hands it over.

---

## Where to find it

**Build Studio → Self-Heal** (the button under the Build Studio logo) is the
one place everything lives: the list of cases, what each one concluded, and
whatever it needs from you.

**Settings → Self Improvement** is where you decide how much of this runs.

---

## Reporting a problem yourself

Click **＋ Report a problem** in Build Studio → Self-Heal and describe what
happened.

Be specific about three things: what you tried, what you expected, and what
actually happened. The Diagnostician reads BrowserOS's real source code to work
out whether you have found a genuine gap or hit a usage error, and specifics are
what let it do that. "The editor is broken" gives it nothing to search for;
"the assistant couldn't open my report in the Editor because `bos_app_launch`
doesn't take a file parameter" gives it everything.

The assistant can do the same thing on its own — if you tell it "that looks like
a BrowserOS bug, report it", it will.

Reporting the same problem twice within an hour is treated as deliberate and
opens a second case. Reporting it twice within a minute by accident is not — the
duplicate is suppressed and linked to the original.

---

## Letting it notice things on its own

Out of the box, **only the explicit trigger is on**. BrowserOS will not open a
case unless you (or the assistant) ask it to. As you come to trust it, you can
switch the automatic triggers on in **Settings → Self Improvement**:

- **Hard error** — one tool failure that isn't an obvious environment problem.
- **Repeated failure** — the same tool failing the same way several times in a
  row (the count and the window are yours to set).
- **Workflow timeout** — a workflow run overrunning its timeout.
- **Log events** — an error-level log from BrowserOS's own internals.

Whatever you switch on, failures that are clearly **not** BrowserOS's fault are
filtered out before anything is spent: network and DNS failures, expired or
missing API keys, rate limits, out-of-memory kills, and upstream service
timeouts. Those never open a case.

One deliberate exception: a **permission denied** error always opens a case.
Only actually looking can tell "your disk said no" apart from "BrowserOS asked
for the wrong thing", and looking is the Diagnostician's job.

---

## What happens to a case

Every case gets read, classified, and then handled according to what it turned
out to be. The badge on each row tells you which:

| Badge | What it found | What BrowserOS does |
|---|---|---|
| **a · env** | something outside BrowserOS | closes the case, changes nothing |
| **b · skill** | the assistant was taught something wrong | proposes one edit to a skill — **you approve it** |
| **c · workflow** | a workflow definition is wrong | proposes one edit to it — **you approve it** |
| **d · notify** | a bug in an app you don't maintain | tells you, and stops there |
| **d-bis · app** | a bug in an app you *do* maintain | fixes it and rebuilds the app |
| **e · core** | a real gap in BrowserOS itself | fixes it on a preview you promote |

Two of these ask you for something:

- **b and c** are the only fixes applied *in place*, so you see the exact
  before/after text and click **Approve edit** or **Dismiss**. Nothing changes
  unless you approve it.
- **e and d-bis** build a fix and then wait. You will get a **fix ready**
  notification; click it and it opens the case.

---

## Reviewing a fix

Open the case. You get the full diagnostics report (what it looked at, what it
concluded, and which files it cited), a timeline of everything that happened,
and the build status.

For a BrowserOS-core fix, click **Pin & open preview** to run that version and
try it. If you like it, **promote** it from the Topbar's version controls, the
same way you promote any other change. If you don't, discard it.

Promotion is always yours. Self-healing has no way to promote anything.

---

## Reading a run's transcript

Everything self-healing does, it does by running an agent with nobody watching —
first the Diagnostician, then (for a core or app fix) the pipeline. Each of those
runs writes a **transcript**, so "what is it actually doing?" has an answer.

Open the case and scroll to **Transcripts**. Each run is listed with its role
(Diagnostician or Pipeline), its run id, and its status; a run still going shows
a green **live** badge. Click **View transcript** and the panel shows that run's
task, every tool call and result, and the assistant text in between — in order,
with a timestamp relative to the run's start.

A live run's transcript **appends while you watch it**, so you can see it
working (or see it going in circles). If the run was flagged as stuck, the
repeated calls are highlighted amber.

Transcripts are ordinary markdown files under
`data/agent-transcripts/<agent>/<run>.md`. They are deliberately **not** in your
Files or your Chats: they are records of what BrowserOS did on its own, not
documents you own. Turning off **Record run transcripts** (Settings → Self
Improvement) stops new ones being written; existing files are kept, and a run
with no transcript simply says so.

---

## Stopping a stuck run

An unattended agent can get stuck — most often by calling the same tool with the
same arguments over and over, learning nothing, until its step budget runs out.
BrowserOS watches for exactly that and tells you, rather than letting it burn
the day's budget in silence.

When it happens, the case shows an amber warning: **⚠ Stuck — repeated
`file_search` ×5 with no progress**. (You do not have to wait for that: the Stop
button is there whenever a run is in flight.)

- **Stop** kills the run — and anything it started, including the developer
  process editing the preview. The case becomes **stopped**, and the transcript
  is kept, marked as stopped, showing exactly where it got to.
- **Start** launches a **fresh** run from the last committed artifact. Nothing
  that was already committed is lost — the pipeline commits each step before it
  moves on — and the new run is told which call not to repeat. The old run stays
  in the Transcripts list to read.

**Stopped is a pause, not a verdict.** The case is not closed, you can Start it
as many times as you like, and — unlike a case waiting on your answer — a
stopped case does **not** hold the pipeline slot, so other fixes can run while
you decide. If you would rather not pursue it at all, dismiss the case.

A run that used up its whole step budget on its own is put in **stopped** too,
for the same reason: there is a complete transcript to read and a Start to try
again, which is more useful than a dead "failed" case.

One thing self-healing deliberately does *not* do: a stuck self-heal run never
opens a new self-heal case about itself. It flags the case it is already working
on and waits for you.

---

## When it needs a decision

Sometimes the fix pipeline hits a genuine fork — two places the fix could go,
both defensible. Rather than guess at your code, it stops and asks.

You will see the case turn **amber and pulse** in the list, with the question
and an answer box. Type an answer and the pipeline picks up where it left off.

While a case is waiting on you, no other automatic fix starts — only one runs
at a time. If you never answer, the case is abandoned after a week (you can
change that under Limits) and the queue moves on.

---

## Keeping it on a leash

**Settings → Self Improvement**:

- **Enable self-healing** — the master switch. Off means no triggers, no
  scheduled reviews, and nothing spent. Everything else greys out.
- **Triggers** — the five above, individually.
- **Scheduled review** — have the Diagnostician periodically look over
  conversations that have gone quiet, catching patterns that never threw an
  error at all.
- **Autonomy** — whether a diagnosed fix may run the whole pipeline unattended,
  whether the developer must write the failing test first, and the coverage it
  should reach.
- **Limits** — the daily token budget, how long a repeat is treated as a
  duplicate, how long a question waits before the case is abandoned, and how
  many cases may queue.
- **Stuck-run detection** — whether to watch for a run going in circles, and
  how many identical calls in a row count as circles (default 5; ids,
  timestamps and numbers are ignored when comparing). Off means no warning —
  Stop and Start still work. This group also holds **Record run transcripts**,
  which governs every unattended run BrowserOS makes, not only self-healing
  ones.

About the **daily token budget**: once it is spent, new problems are **queued
for tomorrow, not dropped**, and a fix already running is allowed to finish
(which means one big fix can overshoot). The budget resets at midnight UTC. The
Self-Heal page shows what you have spent today.

---

## What it will never do

- Promote a fix, or change the version you are running.
- Modify the Supervisor or BrowserOS's build configuration. If a fix needs
  either, it says so and leaves it to a human.
- Modify an app you don't maintain. It tells you about the bug instead.
- Apply a skill or workflow edit you haven't read and approved.

---

## Where the reports live

Every diagnostics report is a markdown file in
**`/Documents/BOS Improvements/`**, alongside the assistant's behavioral
reviews. They are written for you to read — open them in the Files app any
time, including long after the case is closed.

Run transcripts are separate, and are not in your Files: they live outside your
documents at `data/agent-transcripts/<agent>/<run>.md`, and you read them from
the case's **Transcripts** section (see above).
