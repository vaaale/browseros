import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as kernel from "../../src/lib/events/kernel";
import * as store from "../../src/lib/events/store";
import { registerAppUiHandlers } from "../../src/lib/events/register-ui-handlers";
import { useEventTestRoot } from "./_test-env";
import type { AppManifest } from "../../src/os/types";

function app(overrides: Partial<AppManifest>): AppManifest {
  return {
    id: "test-app",
    name: "Test App",
    icon: "Puzzle",
    defaultWidth: 400,
    defaultHeight: 300,
    ...overrides,
  };
}

test.describe("UI handler registration from manifest (US4)", () => {
  test("registers a UI handler declared under the app's own owned root", async () => {
    const { cleanup } = useEventTestRoot("ui-registration-owned");
    try {
      await kernel.startEventKernel();
      await registerAppUiHandlers(
        app({
          id: "gsuite",
          eventHandlers: [{ id: "gsuite-mail", type: "com.bos.gsuite.email.received", displayName: "GSuite Mail" }],
        }),
      );
      const reg = store.getHandler("gsuite:gsuite-mail");
      expect(reg?.mode).toBe("ui");
      expect(reg?.ownerId).toBe("gsuite");
      expect(reg?.declaredBy).toBe("manifest");
      expect(reg?.launch).toEqual({ appId: "gsuite" });

      const forType = kernel.listHandlersForType("com.bos.gsuite.email.received");
      expect(forType.some((h) => h.handlerId === "gsuite:gsuite-mail")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("registers a UI handler declared under a granted namespace outside the app's own root", async () => {
    const { cleanup } = useEventTestRoot("ui-registration-granted");
    try {
      await kernel.startEventKernel();
      await registerAppUiHandlers(
        app({
          id: "digest-app",
          eventNamespaces: ["com.bos.workflow.*"],
          eventHandlers: [{ id: "workflow-run", type: "com.bos.workflow.run.completed", displayName: "Workflow Run View" }],
        }),
      );
      expect(store.getHandler("digest-app:workflow-run")?.eventType).toBe("com.bos.workflow.run.completed");
    } finally {
      await cleanup();
    }
  });

  test("silently skips (does not register) a handler for a namespace the app neither owns nor was granted", async () => {
    const { cleanup } = useEventTestRoot("ui-registration-rejected");
    try {
      await kernel.startEventKernel();
      await registerAppUiHandlers(
        app({
          id: "innocent-app",
          eventHandlers: [{ id: "sneaky", type: "com.bos.someoneelse.thing.happened", displayName: "Sneaky" }],
        }),
      );
      expect(store.getHandler("innocent-app:sneaky")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("an app with no eventHandlers declared registers nothing", async () => {
    const { cleanup } = useEventTestRoot("ui-registration-none");
    try {
      await kernel.startEventKernel();
      await registerAppUiHandlers(app({ id: "plain-app" }));
      expect(store.listHandlers().length).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
