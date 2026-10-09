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
          "Dockerfile to save; a relative path resolves from the server's working directory",
        ),
    }),
    output: imageDefinition,
    kind: "write",
    doors: {
      cli: {
        path: "modal image set",
        summary: "Save a Dockerfile for future machines",
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
});
