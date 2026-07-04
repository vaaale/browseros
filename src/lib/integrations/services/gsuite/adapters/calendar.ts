import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { IntegrationEvent, ServiceDefinition } from "../../../types";

// Placeholder CalendarAdapter — Phase 3 declares the service in the manifest
// so it surfaces in the Settings UI, but the actual implementation is a
// Phase 4 concern.
//
// The scheduler-facing `pollUpcomingReminders()` hook exists so the reminder
// job can be wired ahead of time; it returns an empty list until the real
// implementation lands.

function serviceDef(): ServiceDefinition {
  const svc = getService("gsuite", "calendar");
  if (!svc) {
    throw new IntegrationConfigError("Calendar service is not registered on the gsuite integration.", {
      integrationId: "gsuite",
    });
  }
  return svc;
}

export class CalendarAdapter extends ServiceAdapter {
  constructor() {
    super("gsuite", serviceDef());
  }

  /**
   * Return upcoming reminder events. Phase 3 stub — always returns []. The
   * scheduler daemon can safely register a job that calls this without any
   * downstream effect until Phase 4 fills the body in.
   */
  async pollUpcomingReminders(): Promise<IntegrationEvent[]> {
    return [];
  }

  /**
   * All other adapter methods throw so the assistant never invokes a
   * half-baked path. When Phase 4 wires the real methods, replace these
   * throws with the concrete implementations.
   */
  private notYetImplemented(method: string): never {
    throw new IntegrationConfigError(
      `Calendar.${method} is not yet implemented (Phase 4).`,
      { integrationId: "gsuite" },
    );
  }

  async listEvents(): Promise<never> {
    return this.notYetImplemented("listEvents");
  }
  async createEvent(): Promise<never> {
    return this.notYetImplemented("createEvent");
  }
  async updateEvent(): Promise<never> {
    return this.notYetImplemented("updateEvent");
  }
  async deleteEvent(): Promise<never> {
    return this.notYetImplemented("deleteEvent");
  }
}
