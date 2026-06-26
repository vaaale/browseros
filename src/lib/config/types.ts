// Pluggable configuration system: features/apps register a config "schema"
// (a settings tab) whose fields render in Settings and are auto-exposed to the
// assistant as configuration tools.

export type ConfigFieldType = "text" | "password" | "number" | "boolean" | "select" | "textarea";

export interface ConfigOption {
  value: string;
  label: string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  description?: string;
  placeholder?: string;
  options?: ConfigOption[];
  /** Secret values are never returned in plaintext by the API. */
  secret?: boolean;
}

export interface ConfigSchema {
  namespace: string;
  title: string;
  description?: string;
  fields: ConfigField[];
  /** If set, Settings renders this client component instead of the generic form. */
  customComponent?: string;
  order?: number;
}

export interface ConfigSchemaView extends ConfigSchema {
  /** Current values; secret fields are blanked. */
  values: Record<string, unknown>;
  /** Which secret fields currently have a value set. */
  secretsSet: Record<string, boolean>;
}
