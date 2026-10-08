import { contract, op } from "@bb/plugin";
import type {
  EnsureEnvironmentArgs,
  ThreadEnvironment,
} from "@bb/server-kit/environments/types";
import { z } from "zod";

export const environmentRuntime = contract("environments", {
  ensure: op({
    input: z.custom<EnsureEnvironmentArgs>(),
    output: z.custom<ThreadEnvironment>(),
    kind: "write",
    hooks: "answer",
    internal: true,
  }),
});
