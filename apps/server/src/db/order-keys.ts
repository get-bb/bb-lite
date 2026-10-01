const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LAST_DIGIT = ALPHABET.length - 1;

function digitAt(key: string | null, index: number, fallback: number): number {
  if (key === null || index >= key.length) return fallback;
  const digit = ALPHABET.indexOf(key.charAt(index));
  if (digit < 0) throw new Error(`Invalid order key "${key}"`);
  return digit;
}

export function orderKeyBetween(
  previous: string | null,
  next: string | null,
): string {
  if (previous !== null && next !== null && previous >= next) {
    throw new Error("Order keys must be given in ascending order");
  }
  let prefix = "";
  for (let index = 0; ; index += 1) {
    const low = digitAt(previous, index, 0);
    const high = digitAt(next, index, LAST_DIGIT);
    if (high - low > 1) {
      return prefix + ALPHABET.charAt(Math.floor((low + high) / 2));
    }
    prefix += ALPHABET.charAt(low);
  }
}
