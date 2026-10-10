import { contract, op, service } from "@bb/plugin";
import { z } from "zod";
import type { ModalApi } from "./modal-api.js";

const nameSchema = z.string().trim().min(1).max(80);
export const dockerfileSchema = z.string().min(1).max(65_536);

export const sandboxPresetSchema = z
  .object({
    name: nameSchema,
    cpu: z.number().positive(),
    memoryMiB: z.number().int().positive(),
  })
  .strict();

export const modalImageSchema = z.discriminatedUnion("source", [
  z
    .object({
      name: nameSchema,
      source: z.literal("dockerfile"),
      dockerfile: dockerfileSchema,
    })
    .strict(),
  z
    .object({
      name: nameSchema,
      source: z.literal("image-id"),
      imageId: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

export const launchOptionsSchema = z
  .object({
    presets: z.array(sandboxPresetSchema).max(20),
    images: z.array(modalImageSchema).min(1).max(20),
  })
  .strict();
export type LaunchOptions = z.infer<typeof launchOptionsSchema>;

export const machineInputsSchema = z
  .object({ preset: nameSchema.optional(), image: nameSchema.optional() })
  .strict();
export type MachineInputs = z.infer<typeof machineInputsSchema>;

const imageDefinition = z.object({
  dockerfile: z.string(),
  customized: z.boolean(),
});

const sandboxId = z
  .string()
  .min(1)
  .describe("Debug sandbox started by bb modal sandbox run");
const builtImage = z.object({ imageId: z.string(), logs: z.string() });
const execResult = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

export const modal = contract("modal", {
  api: service<ModalApi>(),
  account: op({
    input: z.object({}),
    output: z.object({ available: z.boolean(), message: z.string() }),
    doors: {
      cli: {
        path: "modal account inspect",
        summary: "Test the configured Modal account",
        print: (output) => output.message,
        exitCode: ({ available }) => (available ? 0 : 1),
      },
    },
  }),
  machine: op({
    input: z.object({
      hostId: z
        .string()
        .min(1)
        .describe("BB host whose Modal machine is inspected"),
    }),
    output: z.object({ summary: z.string(), resource: z.unknown() }),
    doors: {
      cli: {
        path: "modal machine inspect",
        summary: "Inspect Modal compute and the last saved snapshot",
        positionals: ["hostId"],
        print: (output) => output.summary,
      },
    },
  }),
  image: op({
    input: z.object({}),
    output: imageDefinition,
    doors: {
      cli: {
        path: "modal image show",
        summary: "Show the Dockerfile used for new machines",
        print: (output) => output.dockerfile,
      },
    },
  }),
  updateImage: op({
    input: z.object({
      file: z
        .string()
        .min(1)
        .describe(
          "Dockerfile to save; a relative path resolves from cwd on hostId",
        ),
      cwd: z.string().optional().describe("Directory a relative path uses"),
      hostId: z
        .string()
        .optional()
        .describe("Machine to read the file on; default this server"),
    }),
    output: imageDefinition,
    kind: "write",
    doors: {
      cli: {
        path: "modal image set",
        summary: "Save a Dockerfile for future machines",
        from: { cwd: "cwd", hostId: "hostId" },
        print: () => "Saved the Dockerfile for future machines.",
      },
    },
  }),
  deleteImage: op({
    input: z.object({}),
    output: imageDefinition,
    kind: "write",
    doors: {
      cli: {
        path: "modal image reset",
        summary: "Restore the bundled Dockerfile",
        print: () => "Restored the bundled Dockerfile for future machines.",
      },
    },
  }),
  launchOptions: op({ input: z.object({}), output: launchOptionsSchema }),
  updateLaunchOptions: op({
    input: launchOptionsSchema,
    output: launchOptionsSchema,
    kind: "write",
  }),
  createImage: op({
    input: z.object({}),
    output: builtImage,
    kind: "write",
    doors: {
      cli: {
        path: "modal image build",
        summary: "Build or reuse the saved image",
        print: (output) => `${output.logs}${output.imageId}`,
      },
    },
  }),
  createSandbox: op({
    input: z.object({}),
    output: builtImage.extend({ sandboxId: z.string(), expiresAt: z.number() }),
    kind: "write",
    doors: {
      cli: {
        path: "modal sandbox run",
        summary: "Run the saved image in a 30-minute debug sandbox",
        print: (output) => `${output.logs}${output.sandboxId}`,
      },
    },
  }),
  createSandboxCommand: op({
    input: z.object({
      sandboxId,
      command: z
        .array(z.string().max(65_536))
        .min(1)
        .max(128)
        .describe("Command to run, written after --"),
    }),
    output: execResult,
    kind: "write",
    doors: {
      cli: {
        path: "modal sandbox exec",
        summary: "Execute a command in a debug sandbox",
        positionals: ["sandboxId", "command"],
        print: (output) =>
          [
            output.stdout,
            output.stderr,
            output.exitCode === 0 ? "" : `Exit code ${output.exitCode}\n`,
          ].join(""),
        exitCode: (output) => output.exitCode,
      },
    },
  }),
  deleteSandbox: op({
    input: z.object({ sandboxId }),
    output: z.object({ sandboxId: z.string() }),
    kind: "write",
    doors: {
      cli: {
        path: "modal sandbox stop",
        summary: "Stop a debug sandbox",
        positionals: ["sandboxId"],
        print: (output) => `Stopped ${output.sandboxId}`,
      },
    },
  }),
});
