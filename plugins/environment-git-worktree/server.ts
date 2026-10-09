import { jsonValueSchema } from "@bb/domain";
import { environments, type PluginServerApi } from "@bb/plugin";
import { git } from "@bb/runner";
import { ApiError } from "@bb/server-kit/http/errors";
import { z } from "zod";

const branchName = z.string().min(1);

const inputsSchema = z
  .union([
    z.object({ kind: z.literal("existing"), path: z.string().min(1) }).strict(),
    z
      .object({
        branch: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("named"), name: branchName }).strict(),
            z.object({ kind: z.literal("default") }).strict(),
          ])
          .default({ kind: "default" }),
      })
      .strict(),
  ])
  .default({ branch: { kind: "default" } });

function notReady(message: string) {
  return new ApiError(409, "environment_not_ready", message);
}

export default function gitWorktree(bb: PluginServerApi): void {
  bb.add(environments.kind, {
    id: "git-worktree",
    displayName: "Worktree",
    description: "Create an isolated Git worktree for your changes.",
    icon: "FolderGit",
    requires: {
      projectCheckout: true,
      gitCheckout: true,
      gitRemote: false,
      projectless: false,
    },
    inputs: jsonValueSchema.parse(
      z.toJSONSchema(inputsSchema, { io: "input" }),
    ),
    place(inputs, { threadId }) {
      const worktree = inputsSchema.parse(inputs ?? undefined);
      if ("kind" in worktree) {
        const { path } = worktree;
        return { type: "checkout", kind: "project-checkout", path };
      }
      const { branch } = worktree;
      const baseBranch = branch.kind === "named" ? branch.name : null;
      return { type: "owned", instanceKey: `${threadId}-1`, baseBranch };
    },
    async create(context) {
      const { host, checkoutPath: sourcePath, branchName, report } = context;
      if (sourcePath === null) {
        throw notReady("This project has no checkout on the chosen machine.");
      }
      if (context.restoring) {
        const query = {
          path: sourcePath,
          selectedBranch: branchName,
          limit: 1,
        };
        const found = await bb.runners.call(host.id, git.branches, query);
        if (found.selectedBranch?.kind !== "local") {
          const gone = `Branch ${branchName} no longer exists`;
          throw notReady(`${gone}, so its worktree cannot be restored.`);
        }
      }
      const startedAt = bb.now();
      const started = { key: "git-worktree-started", startedAt };
      report("Creating worktree", "started", started);
      const made = await bb.runners.call(host.id, git.createWorktree, {
        sourcePath,
        key: context.instanceKey,
        branchName,
        baseBranch: context.baseBranch,
      });
      const completed = { key: "git-worktree-completed", startedAt };
      report("Created worktree", "completed", completed);
      if (made.worktreeInclude !== null) {
        const { copied, skipped } = made.worktreeInclude;
        const kept = skipped === 0 ? "" : `, skipped ${skipped}`;
        const text = `Copied ${copied} file(s) from .worktreeinclude${kept}`;
        const key = "worktree-include-completed";
        report(text, "completed", { key });
      }
      const { path, mergeBaseBranch } = made;
      return { path, branchName, mergeBaseBranch };
    },
    async delete({ hostId, path }) {
      await bb.runners.call(hostId, git.deleteWorktree, { path });
    },
  });
}
