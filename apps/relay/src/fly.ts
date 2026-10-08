import type { Env } from "./site.js";

export interface Fly {
  apiUrl: string;
  token: string;
  org: string;
  image: string;
  region: string;
  cpuKind: string;
  cpus: number;
  memoryMb: number;
  volumeGb: number;
}

export interface Machine {
  app: string;
  machine: string;
}

const DEFAULT_API_URL = "https://api.machines.dev/v1";
const DATA_PATH = "/data";
const STOP_TIMEOUT_NS = 30_000_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const GONE = 404;

export class FlyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function flyOf(env: Env): Fly | null {
  const { FLY_API_TOKEN: token, FLY_ORG: org, FLY_IMAGE: image } = env;
  if (!token || !org || !image) return null;
  return {
    apiUrl: env.FLY_API_URL ?? DEFAULT_API_URL,
    token,
    org,
    image,
    region: env.FLY_REGION ?? "iad",
    cpuKind: env.FLY_CPU_KIND ?? "shared",
    cpus: Number(env.FLY_CPUS) || 4,
    memoryMb: Number(env.FLY_MEMORY_MB) || 8_192,
    volumeGb: Number(env.FLY_VOLUME_GB) || 20,
  };
}

async function call(fly: Fly, method: string, path: string, body?: unknown) {
  const { token } = fly;
  const headers: Record<string, string> = {
    authorization: token.startsWith("FlyV1 ") ? token : `Bearer ${token}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${fly.apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.slice(0, 300) || response.statusText;
    const message = `Fly answered ${response.status} to ${method} ${path}: ${detail}`;
    throw new FlyError(response.status, message);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function idOf(created: Record<string, unknown>, what: string): string {
  const { id } = created;
  if (typeof id === "string" && id !== "") return id;
  throw new FlyError(502, `Fly created a ${what} without an id`);
}

export async function createMachine(
  fly: Fly,
  app: string,
  env: Record<string, string>,
): Promise<string> {
  const { region } = fly;
  await call(fly, "POST", "/apps", { app_name: app, org_slug: fly.org });
  const volume = await call(fly, "POST", `/apps/${app}/volumes`, {
    name: "data",
    region,
    size_gb: fly.volumeGb,
  });
  const machine = await call(fly, "POST", `/apps/${app}/machines`, {
    name: "server",
    region,
    config: {
      image: fly.image,
      env,
      guest: {
        cpu_kind: fly.cpuKind,
        cpus: fly.cpus,
        memory_mb: fly.memoryMb,
      },
      mounts: [{ volume: idOf(volume, "volume"), path: DATA_PATH }],
      restart: { policy: "on-failure", max_retries: 5 },
      stop_config: { signal: "SIGTERM", timeout: STOP_TIMEOUT_NS },
    },
  });
  return idOf(machine, "machine");
}

export async function startMachine(fly: Fly, { app, machine }: Machine) {
  await call(fly, "POST", `/apps/${app}/machines/${machine}/start`);
}

export async function stopMachine(fly: Fly, { app, machine }: Machine) {
  await call(fly, "POST", `/apps/${app}/machines/${machine}/stop`);
}

export async function destroyApp(fly: Fly, app: string) {
  try {
    await call(fly, "DELETE", `/apps/${app}?force=true`);
  } catch (error) {
    if (!(error instanceof FlyError) || error.status !== GONE) throw error;
  }
}
