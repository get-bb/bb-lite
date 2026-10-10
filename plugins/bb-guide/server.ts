import { existsSync } from "node:fs";
import { join } from "node:path";
import { sessions, type PluginServerApi } from "@bb/plugin";
import { introduction } from "./introduction.js";

const toggle = (label: string, description: string) => ({
  type: "boolean" as const,
  label,
  description,
  default: true,
});

export default function bbGuide(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    introduction: toggle(
      "Send BB introduction",
      "Tell agents about the BB CLI, threads, and clickable links. Applies to new agent sessions.",
    ),
    skills: toggle(
      "Enable bundled skills",
      "Make the selected BB guide skills available to agents.",
    ),
    bbCli: toggle("BB CLI skill", "Inspect and manage BB through the CLI."),
    pluginAuthoring: toggle(
      "Plugin authoring skill",
      "Create and change BB plugins and SDK extensions.",
    ),
    skillCreator: toggle(
      "Skill creator skill",
      "Create and improve BB skills.",
    ),
    submitPlugin: toggle(
      "Plugin submission skill",
      "Prepare and submit a BB plugin to the Community marketplace.",
    ),
  });

  bb.on(sessions.instructions, async (_context, next) => {
    const rest = await next();
    const { introduction: enabled } = await settings.get();
    return enabled
      ? [{ source: bb.pluginId, text: introduction }, ...rest]
      : rest;
  });

  bb.on(sessions.skillDirs, async (_context, next) => {
    const roots = await next();
    const current = await settings.get();
    const skills = {
      "bb-cli": current.bbCli,
      "bb-plugin-authoring": current.pluginAuthoring,
      "skill-creator": current.skillCreator,
      "submit-a-plugin": current.submitPlugin,
    };
    const off = Object.entries(skills)
      .filter(([, on]) => !current.skills || !on)
      .map(([name]) => name);
    return roots.filter((root) =>
      off.every((name) => !existsSync(join(root, name, "SKILL.md"))),
    );
  });
}
