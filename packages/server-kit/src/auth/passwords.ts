import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SCHEME = "scrypt";

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return [SCHEME, salt.toString("base64url"), key.toString("base64url")].join(
    ":",
  );
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  const [scheme, salt, expected] = (stored ?? "").split(":");
  if (scheme !== SCHEME || salt === undefined || expected === undefined) {
    await derive(password, Buffer.alloc(SALT_BYTES));
    return false;
  }
  const key = await derive(password, Buffer.from(salt, "base64url"));
  const known = Buffer.from(expected, "base64url");
  return key.length === known.length && timingSafeEqual(key, known);
}
