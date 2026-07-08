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
