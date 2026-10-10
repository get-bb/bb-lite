import {
  fail,
  plugins,
  projects,
  sessions,
  type PluginServerApi,
} from "@bb/plugin";
import { workspaces } from "@bb/runner";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import { skills, skillsMachine, type Skill } from "./contract.js";
import { registrySource } from "./registry.js";

const DISABLED_KEY = "disabled";
const disabledSchema = z.array(z.string());

type Located = { projectId?: string; hostId?: string };

export default function skillsPlugin(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    registryUrl: {
      type: "string",
      label: "Skills registry",
      description:
        "Address of a skills.sh compatible registry to search, for example https://www.skills.sh. Leave empty to turn the registry off.",
      default: "",
    },
  });
  bb.add(
    skills.source,
    registrySource(async () => settings.get()),
  );

  const readDisabled = async () =>
    new Set(
      disabledSchema.parse((await bb.storage.kv.get(DISABLED_KEY)) ?? []),
    );
  const writeDisabled = async (ids: Set<string>) => {
    await bb.storage.kv.set(DISABLED_KEY, [...ids].sort());
    bb.changed(skills.list);
  };
  const pluginRoots = async () => [
    join(bb.server.cliDir, "skills"),
    ...(await bb.call(plugins.skillDirs, {})),
  ];
  const machine = (hostId: string | undefined) =>
    bb.runners.get(hostId ?? bb.server.hostId);

  async function providerCommands({ projectId, hostId }: Located) {
    const providers = await bb.call(sessions.providers, {});
    const lists = await Promise.all(
      providers.map(async ({ id }) => {
        const found =
          projectId === undefined
            ? await machine(hostId).call(workspaces.commands, {
                providerId: id,
                cwd: null,
              })
            : await bb.call(projects.commands, {
                projectId,
                provider: id,
                ...(hostId === undefined ? {} : { hostId }),
              });
        return found.commands;
      }),
    );
    return lists.flat().filter((command) => command.source === "skill");
  }

  async function list(input: Located): Promise<Skill[]> {
    const disabled = await readDisabled();
    const roots = await pluginRoots();
    const local = machine(undefined);
    const [installed, plugged, commands] = await Promise.all([
      machine(input.hostId).call(skillsMachine.installed, {}),
      local.call(skillsMachine.scan, { roots }),
      providerCommands(input),
    ]);
    const found = new Map<string, Skill>();
    const add = (skill: Omit<Skill, "id">) => {
      const id = `${skill.source}:${skill.name}`;
      if (
        found.has(id) ||
        [...found.values()].some((s) => s.path === skill.path)
      )
        return;
      const enabled = skill.enabled && !disabled.has(id);
      found.set(id, { id, ...skill, enabled });
    };
    for (const skill of installed.skills)
      add({ ...skill, source: "installed" });
    for (const skill of plugged) add({ ...skill, source: "plugin" });
    const inside = (path: string, root: string) => path.startsWith(root + sep);
    for (const command of commands) {
      const { name, description, path } = command;
      if (path === undefined || inside(path, installed.root)) continue;
      if (roots.some((root) => inside(path, root))) continue;
      const user = path.includes(`${sep}.agents${sep}skills${sep}`);
      const native = user ? "user" : "provider";
      const source = command.origin === "project" ? "project" : native;
      add({ name, description, path, source, enabled: true });
    }
    return [...found.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  async function find(input: Located & { id: string }) {
    const all = await list(input);
    const skill =
      all.find((entry) => entry.id === input.id) ??
      all.find((entry) => entry.name === input.id);
    return skill ?? fail("not_found", `Skill ${input.id} not found`);
  }

  async function toggle(input: Located & { id: string }, enabled: boolean) {
    const skill = await find(input);
    const disabled = await readDisabled();
    if (skill.source === "installed") {
      const toggled = { name: skill.name, enabled };
      const moved = await machine(input.hostId).call(
        skillsMachine.toggle,
        toggled,
      );
      disabled.delete(skill.id);
      await writeDisabled(disabled);
      return { ...skill, path: moved.path, enabled };
    }
    if (enabled) disabled.delete(skill.id);
    else disabled.add(skill.id);
    await writeDisabled(disabled);
    return { ...skill, enabled };
  }

  bb.implement(skills.list, list);
  bb.implement(skills.get, async (input) => {
    const skill = await find(input);
    const host = skill.source === "plugin" ? undefined : input.hostId;
    const read = await machine(host).call(skillsMachine.read, {
      path: skill.path,
    });
    return { ...skill, ...read };
  });
  bb.implement(skills.install, async ({ hostId, ...source }) => {
    const installed = await machine(hostId).call(skillsMachine.install, source);
    bb.changed(skills.list);
    return {
      id: `installed:${installed.name}`,
      ...installed,
      source: "installed" as const,
    };
  });
  bb.implement(skills.uninstall, async (input) => {
    const skill = await find(input);
    if (skill.source !== "installed") {
      fail("invalid", `Only installed skills can be removed`, {
        hint: `Disable it instead: bb skill disable ${skill.id}`,
      });
    }
    await machine(input.hostId).call(skillsMachine.remove, {
      name: skill.name,
    });
    bb.changed(skills.list);
    return skill;
  });
  bb.implement(skills.enable, (input) => toggle(input, true));
  bb.implement(skills.disable, (input) => toggle(input, false));
  bb.implement(skills.search, async ({ query = "" }, { signal }) => {
    const sources = bb.read(skills.source);
    const found = await Promise.all(
      sources.map(async (source) => {
        const entries = await source
          .search(query, signal)
          .catch((error: unknown) =>
            fail("unavailable", `${source.label}: ${String(error)}`, {
              reason: "skills_registry_unavailable",
            }),
          );
        return entries.map((entry) => ({ ...entry, sourceId: source.id }));
      }),
    );
    return found.flat();
  });

  const disabledNames = async () =>
    [...(await readDisabled())].map((id) => id.slice(id.indexOf(":") + 1));

  bb.on(projects.commands, async (_input, next) => {
    const result = await next();
    if (next.origin.via.at(-1) === bb.pluginId) return result;
    const off = new Set(await disabledNames());
    const commands = result.commands.filter(
      (command) => command.source !== "skill" || !off.has(command.name),
    );
    return { ...result, commands };
  });

  bb.on(sessions.skillDirs, async (_context, next) => {
    const roots = await next();
    const off = await disabledNames();
    const kept = roots.filter((root) =>
      off.every((name) => !existsSync(join(root, name, "SKILL.md"))),
    );
    const installed = await machine(undefined)
      .call(skillsMachine.installed, {})
      .catch(() => null);
    const root = installed?.skills.some((skill) => skill.enabled)
      ? installed.root
      : null;
    return root === null || kept.includes(root) ? kept : [...kept, root];
  });
}
