import Ajv from "ajv";
import type { ToolValidationResult } from "../tools/types.ts";

// Ajv v8 ships as CJS; normalize the default export across Bun/Node bundling.
const AjvCtor = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as new (
  opts?: Record<string, unknown>,
) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
};

const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  validateSchema: false,
  allowUnionTypes: true,
});

/**
 * Validate a value against a JSON Schema supplied by an MCP server or a custom
 * tool. The schema itself is untrusted, so compilation failures are reported as
 * a validation error rather than thrown into the agent loop.
 */
export function validateWithJsonSchema(
  schema: Record<string, unknown> | undefined,
  input: unknown,
): ToolValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, error: "Tool arguments must be a JSON object" };
    }
    return { ok: true, value: input as Record<string, unknown> };
  }
  const cleaned = { ...schema };
  delete cleaned.$schema;
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(cleaned);
  } catch (err) {
    return { ok: false, error: `Tool has an invalid input schema: ${(err as Error).message}` };
  }
  if (validate(input)) {
    return { ok: true, value: input as Record<string, unknown> };
  }
  const errors = (validate.errors ?? [])
    .slice(0, 8)
    .map((e) => `${e.instancePath || "<input>"} ${e.message ?? "is invalid"}`)
    .join("; ");
  return { ok: false, error: `Invalid tool arguments: ${errors || "schema validation failed"}` };
}
