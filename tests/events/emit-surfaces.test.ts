import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as kernel from "../../src/lib/events/kernel";
import { emitIntegrationEvent } from "../../src/lib/events/from-integration-event";
import { eventsTools } from "../../src/lib/assistant/tools/server/events";
import { useEventTestRoot } from "./_test-env";

function fakeToolContext() {
  return {
    signal: new AbortController().signal,
    conversationId: "test-conv",
    agentId: "test-agent",
    onEvent: () => {},
    elicit: async () => "",
    delegationDepth: 0,
    runId: "test-run",
  };
}

test.describe("emit surfaces (US2)", () => {
  test("emitIntegrationEvent (GSuite re-pointed emitter) derives a namespaced type + friendly summary + GSuite source", async () => {
    const { cleanup } = useEventTestRoot("emit-surfaces-gsuite");
    try {
      await kernel.startEventKernel();
      await emitIntegrationEvent({
        type: "new_email",
        service: "gsuite/gmail",
        timestamp: Date.now(),
        data: { from: "billing@acme.com", subject: "Invoice #4812" },
      });
      const result = kernel.query({});
      expect(result.events.length).toBe(1);
      const e = result.events[0];
      expect(e.type).toBe("com.bos.gsuite.email.received");
      expect(e.source).toEqual({ appId: "gsuite", name: "GSuite" });
      expect(e.summary).toBe("Invoice #4812 — billing@acme.com");
      expect(e.processing).toBe("processed"); // no active handlers yet
    } finally {
      await cleanup();
    }
  });

  test("emitIntegrationEvent falls back to a systematic type for an unknown service/kind pair", async () => {
    const { cleanup } = useEventTestRoot("emit-surfaces-fallback");
    try {
      await kernel.startEventKernel();
      await emitIntegrationEvent({
        type: "custom_thing",
        service: "someapp/widget",
        timestamp: Date.now(),
        data: {},
      });
      const result = kernel.query({});
      expect(result.events[0].type).toBe("com.bos.someapp.widget.custom-thing");
      expect(result.events[0].source.appId).toBe("someapp");
    } finally {
      await cleanup();
    }
  });

  test("emit_event agent tool records the assistant as the source", async () => {
    const { cleanup } = useEventTestRoot("emit-surfaces-assistant");
    try {
      await kernel.startEventKernel();
      const tools = eventsTools();
      const out = await tools.emit_event.execute!(
        { type: "com.bos.assistant.task.done", payload: { summary: "Follow-up drafted" } },
        fakeToolContext(),
      );
      const parsed = JSON.parse(out as string);
      expect(parsed.processing).toBe("processed");

      const full = await kernel.getEventFull(parsed.id);
      expect(full?.source).toEqual({ appId: "assistant", name: "Assistant" });
      expect(full?.summary).toBe("Follow-up drafted");
    } finally {
      await cleanup();
    }
  });

  test("emit_event agent tool surfaces a payload-too-large error in-band (never throws)", async () => {
    const { cleanup } = useEventTestRoot("emit-surfaces-too-large");
    try {
      await kernel.startEventKernel();
      const tools = eventsTools();
      const out = await tools.emit_event.execute!(
        { type: "com.bos.assistant.task.done", payload: { big: "x".repeat(1024 * 1024 + 1) } },
        fakeToolContext(),
      );
      expect(String(out)).toContain("payload-too-large");
    } finally {
      await cleanup();
    }
  });

  test("query_events / get_event / list_event_handlers agent tools round-trip", async () => {
    const { cleanup } = useEventTestRoot("emit-surfaces-query-tools");
    try {
      await kernel.startEventKernel();
      const tools = eventsTools();
      const emitted = JSON.parse(
        (await tools.emit_event.execute!({ type: "com.bos.assistant.task.done", payload: {} }, fakeToolContext())) as string,
      );

      const queried = JSON.parse((await tools.query_events.execute!({}, fakeToolContext())) as string);
      expect(queried.events.some((e: { id: string }) => e.id === emitted.id)).toBe(true);

      const single = JSON.parse((await tools.get_event.execute!({ eventId: emitted.id }, fakeToolContext())) as string);
      expect(single.id).toBe(emitted.id);

      const handlers = JSON.parse((await tools.list_event_handlers.execute!({}, fakeToolContext())) as string);
      expect(typeof handlers).toBe("object");
    } finally {
      await cleanup();
    }
  });
});
