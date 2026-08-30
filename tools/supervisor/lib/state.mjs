// Centralized shared mutable state for the Supervisor. Every other module reads
// and writes state through here instead of importing each other's module-level
// variables — keeps ownership explicit and avoids circular imports between the
// lifecycle modules (base.mjs, preview.mjs, promote.mjs, control.mjs all need
// to read/reassign `base`/`baseBranch`).
//
// ES module bindings can't be reassigned from OUTSIDE the module that exports
// them (only mutated, if they're objects/Maps) — so a whole-branch reassignment
// like `base = swapped` (promote's swap path) can't be
// a plain exported `let` read by other files. `state` is a single shared object
// instead, so other modules do `state.base = swapped`.

/** @typedef {{role:string,branch?:string,worktree?:string,dataDir?:string,port:number,state:string,proc?:import('node:child_process').ChildProcess|null,commit?:string,reused?:boolean,dev?:boolean,expectingExit?:boolean,buildError?:string,buildLog?:string,devopsConversationId?:string}} Version */

/** @type {Map<string, Version>} branch → preview */
export const previews = new Map();

/** In-flight provision de-dup: every caller for a not-yet-provisioned branch
 *  awaits the SAME promise instead of racing addWorktreeForBranch's own
 *  worktree remove/add on the same path. */
export const previewProvisioning = new Map();

/** Base-server supervision counters, exposed via /__supervisor/health. */
export const baseSupervision = {
  restarts: 0,
  consecutiveFailures: 0,
  /** @type {{code:number|null,signal:string|null,at:number,expected:boolean,oomSuspected:boolean}|null} */
  lastExit: null,
  /** @type {number|null} */ lastRestartAt: null,
  givenUp: false,
};

export const state = {
  /** @type {Version|null} */
  base: null,
  /** Resolved to REPO's current branch at startup. */
  baseBranch: "",
  baseRestarting: false,
  shuttingDown: false,
};
