function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const octets = normalized.split(".");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    (octets.length === 4 &&
      octets[0] === "127" &&
      octets.every(
        (octet) =>
          /^\d+$/u.test(octet) &&
          String(Number(octet)) === octet &&
          Number(octet) <= 255,
      ))
  );
}

export function isLocalOnlyUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(url).hostname);
  } catch {
    return false;
  }
  if (isLoopbackHostname(hostname)) return true;
  if (hostname === "0.0.0.0" || hostname === "::") return true;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(hostname);
  if (dotted !== null) return isLoopbackHostname(dotted[1] ?? "");
  const hex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(hostname);
  return hex !== null && Number.parseInt(hex[1] ?? "", 16) >> 8 === 127;
}
