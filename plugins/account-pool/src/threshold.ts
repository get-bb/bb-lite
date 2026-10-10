export const THRESHOLD_ERROR = "Must be greater than 0 and at most 1.";

export type ThresholdInput = { value: number } | { error: string };

export function parseSwitchThreshold(raw: string): ThresholdInput {
  const text = raw.trim();
  const value = Number(text);
  const valid = text !== "" && Number.isFinite(value) && value > 0;
  return valid && value <= 1 ? { value } : { error: THRESHOLD_ERROR };
}
