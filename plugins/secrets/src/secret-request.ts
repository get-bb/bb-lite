import { z } from "zod";

export const SECRET_REQUEST_RENDERER_ID = "secret-request";

export const secretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const secretRequestPayloadSchema = z.object({
  purpose: z.string().min(1).nullable(),
  destination: z.object({ kind: z.literal("dotenv"), path: z.string().min(1) }),
  fields: z
    .array(
      z.object({
        name: secretNameSchema,
        description: z.string().min(1).nullable(),
      }),
    )
    .min(1),
});

const secretValueSchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .regex(/^[^\n\r\0]*$/u, "Secret values must be single-line text");

export const secretRequestResponseSchema = z.object({
  values: z.record(secretNameSchema, secretValueSchema),
});
