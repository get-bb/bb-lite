export interface NumberSettingRule {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function numberSettingError(
  rule: NumberSettingRule,
  draft: string,
): string | null {
  const value = Number(draft);
  const { min = -Infinity, max = Infinity, integer = false } = rule;
  if (
    draft.trim() !== "" &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    value >= min &&
    value <= max
  )
    return null;
  const kind = integer ? "a whole number" : "a number";
  const low = rule.min === undefined ? "" : ` at least ${rule.min}`;
  const high = rule.max === undefined ? "" : ` at most ${rule.max}`;
  return `Enter ${kind}${low}${low && high ? " and" : ""}${high}`;
}
