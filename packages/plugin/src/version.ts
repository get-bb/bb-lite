export const API_VERSION = "1.4.0";
export const API_VERSION_HEADER = "x-bb-api";

type Triple = [number, number, number];

const COMPARATOR =
  /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/u;

function tripleOf(version: string): Triple | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(version.trim());
  if (match === null) return null;
  const [, major = "0", minor = "0", patch = "0"] = match;
  return [Number(major), Number(minor), Number(patch)];
}

function compare(left: Triple, right: Triple): number {
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function nextAfter(low: Triple, given: number): Triple {
  if (given >= 2) return [low[0], low[1] + 1, 0];
  return [low[0] + 1, 0, 0];
}

function caretLimit(low: Triple, given: number): Triple {
  if (low[0] > 0 || given === 1) return [low[0] + 1, 0, 0];
  if (low[1] > 0 || given === 2) return [0, low[1] + 1, 0];
  return [0, 0, low[2] + 1];
}

function matches(version: Triple, comparator: string): boolean {
  const match = COMPARATOR.exec(comparator);
  if (match === null) return false;
  const [, operator = "=", ...fields] = match;
  const numbers = fields.filter((field) => /^\d+$/u.test(field ?? ""));
  const given = numbers.length;
  if (given === 0) return true;
  const [major = 0, minor = 0, patch = 0] = numbers.map(Number);
  const low: Triple = [major, minor, patch];
  const within = (limit: Triple) =>
    compare(version, low) >= 0 && compare(version, limit) < 0;
  if (operator === "^") return within(caretLimit(low, given));
  if (operator === "~") return within(nextAfter(low, given));
  if (operator === ">=") return compare(version, low) >= 0;
  if (operator === "<") return compare(version, low) < 0;
  if (given === 3) {
    const order = compare(version, low);
    if (operator === ">") return order > 0;
    return operator === "<=" ? order <= 0 : order === 0;
  }
  const limit = nextAfter(low, given);
  if (operator === ">") return compare(version, limit) >= 0;
  if (operator === "<=") return compare(version, limit) < 0;
  return within(limit);
}

export function satisfies(version: string, range: string): boolean {
  const parsed = tripleOf(version);
  if (parsed === null) return false;
  return range.split("||").some((alternative) => {
    const comparators = alternative
      .replace(/(>=|<=|>|<|=|\^|~)\s+/gu, "$1")
      .trim()
      .split(/\s+/u);
    return comparators.every((comparator) => matches(parsed, comparator));
  });
}

export function majorOf(version: string): number | null {
  return tripleOf(version)?.[0] ?? null;
}

export function isNewer(version: string, than: string): boolean {
  const [left, right] = [tripleOf(version), tripleOf(than)];
  return left !== null && right !== null && compare(left, right) > 0;
}
