"use client";

import { useCopilotReadable } from "@copilotkit/react-core";
import { useCopilotAction } from "@/components/agent/gated-action";
import { useEffect, useState } from "react";
import type { ConfigSchemaView } from "@/lib/config/types";

// Auto-exposes every registered configuration namespace to the assistant as
// tools, so the agent can read and change any feature/app setting.
export function ConfigActions() {
  const [schemas, setSchemas] = useState<ConfigSchemaView[]>([]);

  const refresh = async () => {
    try {
      const res = await fetch("/api/config").then((r) => r.json());
      setSchemas(res.schemas ?? []);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  useCopilotReadable({
    description: "Configurable BrowserOS settings the assistant can change (namespaces, fields, current values; secrets hidden).",
    value: schemas.map((s) => ({
      namespace: s.namespace,
      title: s.title,
      fields: s.fields.map((f) => ({ key: f.key, type: f.type, options: f.options?.map((o) => o.value) })),
      values: s.values,
    })),
  });

  useCopilotAction({
    name: "listConfigurableSettings",
    description: "List all configurable settings namespaces and their fields.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/config").then((r) => r.json());
      return JSON.stringify(
        (res.schemas ?? []).map((s: ConfigSchemaView) => ({
          namespace: s.namespace,
          title: s.title,
          fields: s.fields.map((f) => f.key),
          values: s.values,
        })),
      );
    },
  });

  useCopilotAction({
    name: "updateSetting",
    description: "Update a configuration value. Use listConfigurableSettings to discover namespaces and field keys.",
    parameters: [
      { name: "namespace", type: "string", description: "Config namespace, e.g. ai-provider, appearance, dev-harness", required: true },
      { name: "key", type: "string", description: "Field key", required: true },
      { name: "value", type: "string", description: "New value", required: true },
    ],
    handler: async ({ namespace, key, value }) => {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, values: { [key as string]: value } }),
      }).then((r) => r.json());
      await refresh();
      return res.error ? `Error: ${res.error}` : `Updated ${namespace}.${key}.`;
    },
  });

  return null;
}
