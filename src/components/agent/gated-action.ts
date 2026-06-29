"use client";

import {
  useCopilotAction as useRawCopilotAction,
  type FrontendAction,
  type CatchAllFrontendAction,
} from "@copilotkit/react-core";
import type { Parameter } from "@copilotkit/shared";
import { useAgentCapabilities } from "./agent-capabilities";

// Drop-in replacement for CopilotKit's useCopilotAction that GATES the action by the
// active/pinned agent's allowlist (016-unified-agents). Action components import
// useCopilotAction from HERE instead of @copilotkit/react-core; the catch-all renderer
// (ChatToolRenderer) keeps importing from CopilotKit so it is never gated.
//
// A disallowed action is replaced with a render-only no-op (`available:"disabled"` +
// `render:()=>null`, with any `renderAndWaitForResponse` stripped). Why not just inject
// `available:"disabled"`: CopilotKit's getActionConfig routes a "disabled" action to the
// RENDER path (useRenderToolCall), which calls the action's `render` unconditionally — so
// a handler-only action (no render) crashes with "render is not a function" the moment its
// tool-call card renders. The no-op render makes the render path safe; routing through
// render (not frontend/hitl) keeps the tool out of the model's offered set.
//
// The signature mirrors CopilotKit's generic so each action's parameters still
// infer its handler argument types.
export function useCopilotAction<const T extends Parameter[] | [] = []>(
  action: FrontendAction<T> | CatchAllFrontendAction,
  dependencies?: unknown[],
): void {
  const { isActionAllowed } = useAgentCapabilities();
  const a = action as { name?: string; available?: unknown };
  const gate = a.name !== undefined && a.name !== "*" && a.available === undefined && !isActionAllowed(a.name);
  let next: FrontendAction<T> | CatchAllFrontendAction = action;
  if (gate) {
    const rest = { ...(action as Record<string, unknown>) };
    delete rest.renderAndWaitForResponse;
    delete rest.renderAndWait;
    next = { ...rest, available: "disabled", render: () => null } as unknown as FrontendAction<T>;
  }
  useRawCopilotAction(next, dependencies as Parameters<typeof useRawCopilotAction>[1]);
}
