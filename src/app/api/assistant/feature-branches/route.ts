import { NextRequest, NextResponse } from "next/server";
import { listFeatureBranches, createFeatureBranch, deleteFeatureBranch, currentBranch } from "@/lib/system/git";
import { normalizeFeatureBranch } from "@/lib/agent/feature-branch";
import { listDeclaredFeatureBranches } from "@/lib/agent/conversations-server";
import { setConversationActiveFeatureBranch } from "@/lib/assistant/conversation-store";
import { setBranchScope, resolveMarketplaceItemId, normalizeItemId, type BranchScope } from "@/lib/specs/branch-scope";
import { logger } from "@/lib/logging/server-logger";

export const dynamic = "force-dynamic";

// Feature branches that Assistant conversations target for developer harness
// work. Under the Supervisor, the git worktree is provisioned by the Supervisor
// itself at delegate time — so a branch a conversation just "activated" via
// dev_branch_request has NO real git ref yet, only a name recorded on that one
// conversation's own file, until dev_delegate actually runs under it. Merge
// those declared-but-not-yet-real names in too, so a DIFFERENT conversation
// can select the same branch immediately instead of waiting for it to
// materialize — see listDeclaredFeatureBranches's own doc comment.
async function allKnownFeatureBranches(): Promise<string[]> {
  const [real, declared] = await Promise.all([listFeatureBranches(), listDeclaredFeatureBranches()]);
  return Array.from(new Set([...real, ...declared])).sort();
}

export async function GET() {
  return NextResponse.json({ featureBranches: await allKnownFeatureBranches() });
}

export async function POST(req: NextRequest) {
  let body: { name?: unknown; scope?: unknown; scopeId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const branch = normalizeFeatureBranch(name);
  if (!branch) {
    return NextResponse.json(
      { ok: false, error: `Invalid branch name "${name}": use a lowercase kebab name like "my-change" (1-4 words).` },
      { status: 400 },
    );
  }
  // WHAT the branch is for, resolved BEFORE the branch exists. Validating after
  // creating it meant a refused scope still left a branch behind — and the
  // branch is the expensive half, since the Supervisor couples repositories to
  // it. Nothing is written here; this only decides.
  const scopeKind = typeof body.scope === "string" ? body.scope : "";
  const scopeId = typeof body.scopeId === "string" ? body.scopeId : "";
  let scope: BranchScope | undefined;
  let scopeNote: string | undefined;
  if (scopeKind === "bos-core") scope = { kind: "bos-core" };
  else if (scopeKind === "marketplace-item") {
    // `itemId` stays optional — every marketplace item couples the same two
    // repos, so the picker never had to ask which. It matters for ATTRIBUTION:
    // it is what tells the item being worked on from the ten others sharing
    // user-apps.
    //
    // AN UNKNOWN ID IS NOT AN ERROR. This used to refuse anything not already
    // installed, which made starting a NEW app impossible: the branch has to
    // exist BEFORE the item does — every `app_spec_*` and `app_build` call is
    // refused without one — so `dev_branch_request` for a new app necessarily
    // names something that does not exist yet. A real session hit exactly that,
    // `scopeId "follow-the-money" is not an installed marketplace item`, with no
    // way forward at all.
    //
    // The scope is self-correcting: it points at nothing while the app does not
    // exist, and at the app the moment it does, because `createItemSpec`
    // slugifies the same name into the same id. So an unrecognised id is
    // REPORTED rather than refused — a typo still surfaces, naming what IS
    // installed, without blocking the work it was trying to start.
    //
    // Reported at INFO, not warn. The message's own content is "this is
    // correct"; logging it as a warning would contradict it, and a warn level
    // that routinely fires on the normal path is how real warnings stop being
    // read.
    if (!scopeId) scope = { kind: "marketplace-item" };
    else {
      const resolved = await resolveMarketplaceItemId(scopeId);
      if (resolved.ok) scope = { kind: "marketplace-item", itemId: resolved.itemId };
      else {
        scope = { kind: "marketplace-item", itemId: normalizeItemId(scopeId) };
        scopeNote =
          `scopeId "${scopeId}" matches no installed marketplace item yet — recorded anyway, which is ` +
          `correct for an app being created. Installed: ${resolved.known.join(", ") || "(none)"}. ` +
          `If that was a typo, this branch will not be attributed to any item until one exists under that id.`;
      }
    }
  } else if (scopeKind === "repository" && scopeId) scope = { kind: "repository", repoId: scopeId };
  else if (scopeKind) {
    return NextResponse.json(
      { ok: false, error: `scope "${scopeKind}"${scopeId ? ` / "${scopeId}"` : ""} is not one of: bos-core, marketplace-item (with optional scopeId), repository (with scopeId).` },
      { status: 400 },
    );
  }

  try {
    // Under the Supervisor this throws (worktree provisioned at delegate time);
    // in standalone dev mode it creates or checks out the branch.
    await createFeatureBranch(branch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Suppress the expected "Supervisor owns git" guard — the Supervisor handles
    // branch creation itself, so from the UI's perspective this is still success.
    if (!msg.includes("Supervisor")) {
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
  }
  // Recorded where the Supervisor — a separate process — can read it. Without a
  // scope a branch couples BOS's own repos only (coupled-repos.mjs), which is
  // safe but not always right: a marketplace change would not get user-apps.
  //
  // Not inferred: a branch is created BEFORE anything is written to it, so there
  // is nothing to infer from. The agent already decides what kind of change this
  // is in order to load the right skills; this records that decision.
  if (scope) await setBranchScope(branch, scope);
  // Returned to the caller, not merely logged: the elicitation card is the one
  // place a mistyped item id can still be noticed and corrected. `note`, not
  // `warning` — nothing went wrong here.
  if (scopeNote) logger().info("assistant.feature-branches", scopeNote, { branch });

  const featureBranches = await allKnownFeatureBranches();
  return NextResponse.json({ ok: true, branch, featureBranches, ...(scopeNote ? { note: scopeNote } : {}) });
}

// Set (or clear) a conversation's `activeFeatureBranch`. Routed through
// conversation-store.ts's own per-conversation queue — not a plain VFS write
// — so this serializes against the v2 agent loop's own message saves instead
// of racing them (see setConversationActiveFeatureBranch's doc comment).
export async function PATCH(req: NextRequest) {
  let body: { conversationId?: unknown; branch?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  if (!conversationId) {
    return NextResponse.json({ ok: false, error: "conversationId is required" }, { status: 400 });
  }
  const raw = typeof body.branch === "string" ? body.branch.trim() : "";
  if (!raw) {
    await setConversationActiveFeatureBranch(conversationId, undefined);
    return NextResponse.json({ ok: true, branch: undefined });
  }
  const branch = normalizeFeatureBranch(raw);
  if (!branch) {
    return NextResponse.json({ ok: false, error: `Invalid branch name "${raw}".` }, { status: 400 });
  }
  await setConversationActiveFeatureBranch(conversationId, branch);
  return NextResponse.json({ ok: true, branch });
}

// Branches that must never be deleted through this route, whatever the caller
// asks for. `bos/031-self-healing` is the self-heal candidate itself — the
// branch the e2e suite that calls this endpoint is being developed on, so its
// own cleanup hook must not be able to saw off the limb it sits on.
const PROTECTED_BRANCHES = new Set(["bos/031-self-healing"]);

/**
 * Delete a `bos/<kebab>` feature branch by name (`?name=bos/foo`). This exists
 * because branches are created for real at delegate time (`supervisorBegin`),
 * so runs that never promote — e2e runs above all — leave real refs behind
 * with nothing to reap them.
 *
 * Deleting a name that has no local ref is a success (`existed: false`), so a
 * cleanup loop over the *declared* branch names GET returns (which include
 * ones never materialized) doesn't have to special-case them.
 */
export async function DELETE(req: NextRequest) {
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json({ ok: false, error: "A ?name=bos/<kebab-name> query param is required." }, { status: 400 });
  }
  if (PROTECTED_BRANCHES.has(name)) {
    return NextResponse.json({ ok: false, error: `Refusing to delete protected branch "${name}".` }, { status: 400 });
  }
  const active = await currentBranch().catch(() => "");
  if (name === active) {
    return NextResponse.json(
      { ok: false, error: `Refusing to delete "${name}": it is the active base branch this BOS is running on.` },
      { status: 400 },
    );
  }
  try {
    const { branch, existed } = await deleteFeatureBranch(name);
    return NextResponse.json({ ok: true, deleted: branch, existed, featureBranches: await allKnownFeatureBranches() });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // An invalid name is the caller's fault; anything else (a branch checked
    // out in a worktree, a git failure) is a server-side condition.
    return NextResponse.json({ ok: false, error }, { status: error.startsWith("Invalid branch name") ? 400 : 500 });
  }
}

// Set (or clear) a conversation's `activeFeatureBranch`. Routed through
// conversation-store.ts's own per-conversation queue — not a plain VFS write
// — so this serializes against the v2 agent loop's own message saves instead
// of racing them (see setConversationActiveFeatureBranch's doc comment).
export async function PATCH(req: NextRequest) {
  let body: { conversationId?: unknown; branch?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  if (!conversationId) {
    return NextResponse.json({ ok: false, error: "conversationId is required" }, { status: 400 });
  }
  const raw = typeof body.branch === "string" ? body.branch.trim() : "";
  if (!raw) {
    await setConversationActiveFeatureBranch(conversationId, undefined);
    return NextResponse.json({ ok: true, branch: undefined });
  }
  const branch = normalizeFeatureBranch(raw);
  if (!branch) {
    return NextResponse.json({ ok: false, error: `Invalid branch name "${raw}".` }, { status: 400 });
  }
  await setConversationActiveFeatureBranch(conversationId, branch);
  return NextResponse.json({ ok: true, branch });
}
