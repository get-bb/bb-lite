const DIFF_WORKER_POOL_MAX_SIZE = 4;
const DIFF_WORKER_POOL_CONSTRAINED_MAX_SIZE = 2;
const DIFF_WORKER_POOL_MIN_SIZE = 1;
const CONSTRAINED_DEVICE_MEMORY_GB = 4;

interface DiffWorkerPoolEnvironment {
  hardwareConcurrency: number | undefined;
  deviceMemory: number | undefined;
}

export function computeDiffWorkerPoolSize({
  hardwareConcurrency,
  deviceMemory,
}: DiffWorkerPoolEnvironment): number {
  if (hardwareConcurrency === undefined || hardwareConcurrency <= 2) {
    return DIFF_WORKER_POOL_MIN_SIZE;
  }
  const constrained =
    deviceMemory !== undefined && deviceMemory <= CONSTRAINED_DEVICE_MEMORY_GB;
  const maxSize = constrained
    ? DIFF_WORKER_POOL_CONSTRAINED_MAX_SIZE
    : DIFF_WORKER_POOL_MAX_SIZE;
  return Math.max(
    DIFF_WORKER_POOL_MIN_SIZE,
    Math.min(maxSize, hardwareConcurrency - 1),
  );
}

function readDeviceMemory(): number | undefined {
  if (typeof navigator === "undefined") return undefined;
  const value: unknown = Reflect.get(navigator, "deviceMemory");
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function getDiffWorkerPoolSize(): number {
  return computeDiffWorkerPoolSize({
    hardwareConcurrency:
      typeof navigator !== "undefined"
        ? navigator.hardwareConcurrency
        : undefined,
    deviceMemory: readDeviceMemory(),
  });
}

export function createDiffWorker(): Worker {
  return new Worker(
    new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url),
    { name: "pierre-diffs-worker", type: "module" },
  );
}
