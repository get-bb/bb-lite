export interface QueryOptions {
  enabled?: boolean;
}

export function requireEnabledQueryArg<T>(args: {
  value: T | null | undefined;
  hookName: string;
  argName: string;
}): T {
  const { value, hookName, argName } = args;
  if (value == null || value === "") {
    throw new Error(
      `${hookName}: ${argName} is required when query is enabled`,
    );
  }
  return value;
}
