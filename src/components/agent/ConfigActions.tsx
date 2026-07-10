"use client";

import { useCopilotReadable, useCopilotAction } from "@copilotkit/react-core";
import { useCallback, useEffect, useState } from "react";
import type { ConfigSchemaView } from "@/lib/config/types";
import { fetchToolJson, runToolHandler } from "@/lib/agent/tool-kernel";

// Auto-exposes every registered configuration namespace to the assistant as
// tools, so the agent can read and change any feature/app setting.
export function ConfigActions() {
  const [schemas, setSchemas] = useState<ConfigSchemaView[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/config").then((r) => r.json());
      setSchemas(res.schemas ?? []);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);

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
    name: "config_list",
    description: "List all configurable settings namespaces and their fields.",
    parameters: [],
    handler: () =>
      runToolHandler("config_list", async ({ signal }) => {
        const out = await fetchToolJson("config_list", "/api/config", { signal });
        if (!out.ok) return out.error;
        const res = out.data as { schemas?: ConfigSchemaView[] };
        return JSON.stringify(
          (res.schemas ?? []).map((s: ConfigSchemaView) => ({
            namespace: s.namespace,
            title: s.title,
            fields: s.fields.map((f) => f.key),
            values: s.values,
          })),
        );
      }),
  });

  useCopilotAction({
    name: "config_set",
    description: "Update a configuration value. Use listConfigurableSettings to discover namespaces and field keys.",
    parameters: [
      { name: "namespace", type: "string", description: "Config namespace, e.g. ai-provider, appearance, dev-harness", required: true },
      { name: "key", type: "string", description: "Field key", required: true },
      { name: "value", type: "string", description: "New value", required: true },
    ],
    handler: ({ namespace, key, value }) =>
      runToolHandler("config_set", async ({ signal }) => {
        const out = await fetchToolJson("config_set", "/api/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace, values: { [key as string]: value } }),
          signal,
        });
        if (!out.ok) return out.error;
        const res = out.data as { error?: string };
        await refresh();
        return res.error ? `Error: ${res.error}` : `Updated ${namespace}.${key}.`;
      }),
  });

  return null;
}
