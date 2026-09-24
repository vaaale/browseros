// Machine-readable codes for spec-store refusals.
//
// Framework-free and NOT `server-only`, deliberately: the whole point is that
// the server raising a refusal and the client rendering it agree on the same
// identifier. A client that had to match on message text would break the moment
// the message was reworded — and these messages get reworded, because several
// of them are written for an AGENT and have to keep naming the exact tool and
// argument that recovers.

/** A write was attempted against a writable store with no feature branch active.
 *
 *  Carried so a UI can say what a PERSON should do. The error's own message
 *  tells an agent to call `dev_branch_request`; a human in Build Studio has no
 *  such tool, and the branch selector in front of them already does it. */
export const BRANCH_REQUIRED = "branch_required";
