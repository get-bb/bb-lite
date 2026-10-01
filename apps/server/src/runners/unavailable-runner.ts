import { RunnerError } from "@bb/runner";
import type { ServerRunner } from "../context.js";

export function createUnavailableRunner(): ServerRunner {
  const reject = (): Promise<never> =>
    Promise.reject(
      new RunnerError("unavailable", "This machine has no runner yet"),
    );
  return new Proxy({} as ServerRunner, { get: () => reject });
}
