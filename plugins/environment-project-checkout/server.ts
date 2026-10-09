import { jsonValueSchema } from "@bb/domain";
import { environments, type PluginServerApi } from "@bb/plugin";
import { ApiError } from "@bb/server-kit/http/errors";
import { z } from "zod";

const branchName = z.string().min(1);

const inputsSchema = z.object({
  path: z.string().min(1).optional(),
  branch: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("existing"), name: branchName }).strict(),
      z.object({ kind: z.literal("new"), baseBranch: branchName }).strict(),
    ])
    .optional(),
});

export default function projectCheckout(bb: PluginServerApi): void {
  bb.add(environments.kind, {
    id: "project-checkout",
    displayName: "Project checkout",
    description: "Work in a project checkout on this machine.",
    icon: "Laptop",
    requires: {
      projectCheckout: true,
      gitCheckout: false,
      gitRemote: false,
      projectless: false,
    },
    inputs: jsonValueSchema.parse(
      z.toJSONSchema(inputsSchema, { io: "input" }),
    ),
    place(inputs) {
      const { path, branch } = inputsSchema.parse(inputs ?? {});
      return { type: "checkout", path, branch };
    },
    async create() {
      const message = "This kind of environment attaches to an existing path.";
      throw new ApiError(409, "environment_not_ready", message);
    },
    async delete() {},
  });
}
