// Client-side, fire-and-forget notice to the self-heal spine that a feature
// branch was just promoted or discarded (031-self-healing FR-038a). Shared by
// the two surfaces that settle branches — the desktop topbar VersionControls
// and Settings → Versions — so the wording of "best effort" lives in one place:
// no await, no retry, a console.warn at most. Losing this call is fine by
// design; the boot reconcile (FR-038b) settles the same cases from git ancestry
// after the restart a promote causes anyway.

export function notifySelfHealBranchSettled(branch: string, outcome: "promoted" | "discarded"): void {
  if (!branch) return;
  void fetch("/api/self-heal?op=branch-settled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, outcome }),
    // Both callers reload the page right after — keepalive lets the request
    // survive the navigation instead of being aborted with it.
    keepalive: true,
  }).catch((err) => {
    console.warn(`self-heal branch-settled notification failed for ${branch}`, err);
  });
}
