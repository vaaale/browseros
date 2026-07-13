// Client-side interpreter for A2UI user actions on the UI Preview surface
// (025-ui-preview-a2ui-tools, "Level A" local interactivity). A2UI Buttons and
// other components carry an `action: { event: { name, context } }`; when clicked
// the renderer dispatches it to the A2UIProvider's `onAction` callback. Without
// a handler the click does nothing (inert mockup). This handler makes clicks
// mutate the surface's own DATA MODEL locally — no agent round-trip — so
// components bound to those paths (`{ "path": "/..." }`) update reactively.
//
// Supported conventions (the generation prompt in src/lib/a2ui/service.ts tells
// the sub-agent to emit these):
//   - setData: { name: "setData", context: { target, value } } → set /target = value
//   - openUrl: { name: "openUrl", context: { url } }            → open the url
//
// NOTE the data-path key is `target`, NOT `path`: A2UI reserves a `{ path }`
// object as a data-model READ binding, so an action context literally keyed
// `path` gets resolved-away to the value at that path before it ever reaches
// here (the whole context would arrive empty). `target` sidesteps that.

export interface A2UIUserAction {
  name?: string;
  surfaceId?: string;
  context?: Record<string, unknown>;
}

export interface A2UIActionMessage {
  userAction?: A2UIUserAction;
}

type PushOps = (operations: Record<string, unknown>[]) => void;

/** Apply a dispatched user action against the surface. `pushOps` is the A2UI
 *  `processMessages` for the mounted surface; `openUrl` opens a link. Pure
 *  aside from those injected effects, so it is unit-testable. Returns the
 *  action name it handled (or null if ignored) for logging/tests. */
export function applySurfaceAction(
  message: A2UIActionMessage,
  deps: { pushOps: PushOps; openUrl?: (url: string) => void },
): string | null {
  const action = message?.userAction;
  if (!action || typeof action.name !== "string") return null;
  const surfaceId = typeof action.surfaceId === "string" && action.surfaceId ? action.surfaceId : "dynamic-surface";
  const ctx = action.context ?? {};

  switch (action.name) {
    case "setData": {
      const target = ctx.target;
      if (typeof target !== "string" || !target.startsWith("/")) return null;
      deps.pushOps([{ version: "v0.9", updateDataModel: { surfaceId, path: target, value: ctx.value } }]);
      return "setData";
    }
    case "openUrl": {
      const url = ctx.url;
      if (typeof url === "string" && url) deps.openUrl?.(url);
      return "openUrl";
    }
    default:
      // An unrecognized action name (e.g. one the model invented). Not fatal —
      // the caller logs it so it's visible rather than silently swallowed.
      return null;
  }
}
