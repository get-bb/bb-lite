const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function pick(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let text = "";
  for (const byte of bytes) text += alphabet[byte % alphabet.length];
  return text;
}

export function newId(prefix: string): string {
  return `${prefix}_${pick(ID_ALPHABET, 12)}`;
}

export function newToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${base64Url(bytes)}`;
}

export function newUserCode(): string {
  return `${pick(USER_CODE_ALPHABET, 4)}-${pick(USER_CODE_ALPHABET, 4)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  const bytes = [...new Uint8Array(digest)];
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
