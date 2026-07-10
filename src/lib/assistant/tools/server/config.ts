import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { listConfigSchemas, getRegistration } from "@/lib/config/registry";
import type { ConfigField } from "@/lib/config/types";

// Configuration tools, ported from ConfigActions.tsx: every registered config
// namespace is readable/writable by the assistant. Secret values are masked on
// read (same contract as /api/config) and empty secrets are skipped on write.

function maskValues(fields: ConfigField[], raw: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) values[f.key] = f.secret ? "" : (raw[f.key] ?? "");
  return values;
}

function coerce(fields: ConfigField[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (f.secret && (v === "" || v == null)) continue; // empty secret = keep existing
    if (f.type === "number") {
      const n = Number(v);
      if (!Number.isNaN(n) && v !== "") out[f.key] = n;
    } else if (f.type === "boolean") {
      out[f.key] = v === "false" ? false : !!v;
    } else {
      out[f.key] = v;
    }
  }
  return out;
}

export function configTools(): Record<string, AssistantTool> {
  return {
    config_list: serverTool(
      "config_list",
      "List all configurable settings namespaces and their fields.",
      schema(),
      async () => {
        const out: unknown[] = [];
        for (const s of listConfigSchemas()) {
          const reg = getRegistration(s.namespace);
          if (!reg) continue;
          const raw = await reg.load();
          out.push({
            namespace: s.namespace,
            title: s.title,
            fields: s.fields.map((f) => f.key),
            values: maskValues(s.fields, raw),
          });
        }
        return JSON.stringify(out);
      },
    ),

    config_set: serverTool(
      "config_set",
      "Update a configuration value. Use listConfigurableSettings to discover namespaces and field keys.",
      schema(
        {
          namespace: p.str("Config namespace, e.g. ai-provider, appearance, dev-harness"),
          key: p.str("Field key"),
          value: p.str("New value"),
        },
        ["namespace", "key", "value"],
      ),
      async (input) => {
        const namespace = String(input.namespace ?? "");
        const key = String(input.key ?? "");
        const reg = getRegistration(namespace);
        if (!reg) return `Error: config_set: Unknown config namespace: ${namespace} — call config_list to see valid namespaces.`;
        const patch = coerce(reg.schema.fields, { [key]: input.value });
        await reg.save(patch);
        return `Updated ${namespace}.${key}.`;
      },
    ),
  };
}
