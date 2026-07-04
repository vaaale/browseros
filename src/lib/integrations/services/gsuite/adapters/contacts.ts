import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { ServiceDefinition } from "../../../types";

// Placeholder ContactsAdapter — Phase 3 declares the service in the manifest
// so it appears in the Settings UI, but the actual People API integration is
// deferred to Phase 4. All methods throw a config error so the invoke route
// maps them to a 400 the LLM can reason about.

function serviceDef(): ServiceDefinition {
  const svc = getService("gsuite", "contacts");
  if (!svc) {
    throw new IntegrationConfigError("Contacts service is not registered on the gsuite integration.", {
      integrationId: "gsuite",
    });
  }
  return svc;
}

export class ContactsAdapter extends ServiceAdapter {
  constructor() {
    super("gsuite", serviceDef());
  }

  private notYetImplemented(method: string): never {
    throw new IntegrationConfigError(
      `Contacts.${method} is not yet implemented (Phase 4).`,
      { integrationId: "gsuite" },
    );
  }

  async listContacts(): Promise<never> {
    return this.notYetImplemented("listContacts");
  }
  async getContact(): Promise<never> {
    return this.notYetImplemented("getContact");
  }
  async searchContacts(): Promise<never> {
    return this.notYetImplemented("searchContacts");
  }
}
