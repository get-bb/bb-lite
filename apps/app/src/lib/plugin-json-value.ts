import { jsonValueSchema } from "@bb/domain";
import type { JsonValue } from "@bb/domain";

export function serializePluginPanelParams(
  params: JsonValue | undefined,
): string | null {
  if (params === undefined) return null;
  const result = jsonValueSchema.safeParse(params);
  if (!result.success) throw new Error('"params" must be a JSON value');
  return JSON.stringify(result.data);
}

export function parsePersistedPluginPanelParams(
  paramsJson: string | null,
): JsonValue | null {
  try {
    const result = jsonValueSchema.safeParse(JSON.parse(paramsJson ?? ""));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
