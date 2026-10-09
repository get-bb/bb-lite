import { environments, type PluginServerApi } from "@bb/plugin";
import { git, workspaces } from "@bb/runner";

export default function personalWorkspace(bb: PluginServerApi): void {
  bb.add(environments.kind, {
    id: "personal-workspace",
    displayName: "Personal workspace",
    description: "Create a personal directory without a project.",
    icon: "Folder",
    workspace: "personal",
    default: 1,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    inputs: null,
    async create({ host, instanceKey }) {
      const key = instanceKey;
      const made = await bb.runners.call(host.id, workspaces.ensurePersonal, {
        key,
      });
      return { path: made.path };
    },
    async delete({ hostId, path }) {
      await bb.runners.call(hostId, git.deleteWorktree, { path });
    },
  });
}
