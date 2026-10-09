export const PI_MINIMUM_VERSION = "0.84.0";
const INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";

export function piVersionFrom(output: string) {
  return /\d+\.\d+\.\d+/.exec(output)?.[0] ?? null;
}

function compare(a: string, b: string) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function piUnsupported(version: string | null) {
  if (version === null || compare(version, PI_MINIMUM_VERSION) >= 0) {
    return null;
  }
  return `Pi ${version} is older than the supported minimum ${PI_MINIMUM_VERSION}. Install @earendil-works/pi-coding-agent ${PI_MINIMUM_VERSION} or newer: ${INSTALL_COMMAND}`;
}
