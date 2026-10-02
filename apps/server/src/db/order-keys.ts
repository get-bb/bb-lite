const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LAST_DIGIT = DIGITS.length - 1;

function digitAt(key: string | null, index: number, fallback: number): number {
  if (key === null || index >= key.length) return fallback;
  const digit = DIGITS.indexOf(key.charAt(index));
  if (digit < 0) throw new Error(`Invalid order key '${key}'`);
  return digit;
}

export function orderKeyBetween(
  previous: string | null,
  next: string | null,
): string {
  if (previous !== null && next !== null && previous >= next) {
    throw new Error("Order keys must ascend");
  }
  let prefix = "";
  for (let index = 0; ; index += 1) {
    const low = digitAt(previous, index, 0);
    const high = digitAt(next, index, LAST_DIGIT);
    if (high - low > 1) {
      return prefix + DIGITS.charAt(Math.floor((low + high) / 2));
    }
    prefix += DIGITS.charAt(low);
  }
}
