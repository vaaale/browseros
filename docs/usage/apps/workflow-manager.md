# Workflow Manager

**Workflow Manager** is an installed app for building and running **workflows** —
multi‑step automations where each step delegates work to a sub‑agent or calls a
tool, with dependencies between steps.

> Workflow Manager is an *installed* app (it appears once installed), not a
> built‑in one. If you don't see it, ask the assistant to install or rebuild it.

---

## What a workflow is

A workflow is a small **graph of steps**:

- Each **step** is one of:
  - **delegate** — hand a task to a sub‑agent.
  - **tool** — have a sub‑agent call exactly one named tool.
  - **ag‑ui** — emit a UI/data payload.
- Steps can declare **dependencies** on earlier steps; independent steps run in
  parallel (up to a configurable limit).
- Steps support **retries** (with backoff) for transient failures and an optional
  **timeout**.
- A workflow references the **agents** it uses; those must exist as sub‑agents in
  BOS.

Workflows are saved in your files under `Workflows/`, so they persist and you can
inspect them.

---

## Running a workflow

When a workflow runs, BOS executes the graph and **streams step events** live —
you can watch steps start, retry, complete, or fail, and see the final state
(completed / failed / cancelled). You can **cancel** a run in progress.

---

## Creating workflows with the assistant

The easiest way to create one is to **describe it to the assistant**:

> "Make a workflow that researches a topic with the Researcher agent, then has the
> Writer agent draft a summary from the research."

The assistant can **generate** a workflow from your description, **validate** it
(checking the step graph is acyclic, every referenced agent exists, and
dependencies resolve), **run** it, report **status**, **cancel** it, and **export**
its JSON. You can then refine it in the app or by asking for changes.

---

## Browser steps

If you've enabled [browser automation](../settings/browser-automation.md),
workflow steps can also drive a real browser (navigate, click, extract), making
web automations a natural fit for workflows.
