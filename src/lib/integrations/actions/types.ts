// Framework-free metadata shape shared between adapter modules and the
// dispatcher. Adapters export a `readonly XyzMethodMeta[]` (e.g. GMAIL_METHODS
// in services/gsuite/adapters/gmail.ts) using this contract; the dispatcher
// consumes it to build CopilotKit action descriptors AND the invoke route
// looks up the method by name.

export type AdapterMethodParameterType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "string[]"
  | "number[]"
  | "boolean[]"
  | "object[]";

export interface AdapterMethodParameter {
  name: string;
  type: AdapterMethodParameterType;
  description: string;
  required?: boolean;
}

// `"string[]"` etc. are an authoring shorthand for descriptor files — NOT valid
// JSON Schema `type` values. Sending `{"type":"string[]"}` straight to a model
// provider gets the whole tool-calling request rejected (some providers, e.g.
// Gemini-family parsers, 400 with "Unrecognized schema" — the request fails for
// EVERY tool in that turn, not just the one with the bad param). Convert these
// pseudo-types to `{ type: "array", items: { type: <base> } }` here so every
// caller building a JSON Schema from adapter parameters gets it right once.
const ARRAY_ITEM_TYPE: Partial<Record<AdapterMethodParameterType, string>> = {
  "string[]": "string",
  "number[]": "number",
  "boolean[]": "boolean",
  "object[]": "object",
};

/** Build a JSON Schema `{type:"object", properties, required}` from adapter
 *  method parameters — the single place adapter metadata becomes the schema
 *  handed to a model provider. */
export function adapterParametersToJsonSchema(parameters: readonly AdapterMethodParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of parameters) {
    const itemType = ARRAY_ITEM_TYPE[param.type];
    properties[param.name] = itemType
      ? { type: "array", items: { type: itemType }, description: param.description }
      : { type: param.type, description: param.description };
    if (param.required) required.push(param.name);
  }
  return { type: "object", properties, required };
}

/**
 * Adapter-side metadata for one method. `invoke` closes over the adapter
 * instance's `this` so the dispatcher never needs to know the concrete
 * adapter type — it just calls `meta.invoke(adapter, args)`.
 */
export interface AdapterMethodMeta<A = unknown> {
  method: string;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
  invoke(adapter: A, args: Record<string, unknown>): Promise<unknown>;
}
