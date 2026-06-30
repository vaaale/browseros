import "server-only";
import Ajv, { type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

const schemaCache = new Map<string, ValidateFunction>();

function cacheKey(server: string, tool: string): string {
  return `${server}.${tool}`;
}

export function validateToolArguments(
  server: string,
  tool: string,
  inputSchema: unknown,
  args: Record<string, unknown>,
): { valid: boolean; error?: string } {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { valid: true };
  }

  const key = cacheKey(server, tool);
  let validate = schemaCache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(inputSchema as object);
      schemaCache.set(key, validate);
    } catch {
      return { valid: true };
    }
  }

  const valid = validate(args);
  if (!valid) {
    return {
      valid: false,
      error: ajv.errorsText(validate.errors, { separator: ", " }),
    };
  }
  return { valid: true };
}
