import { contract, op, slot } from "@bb/plugin";
import { z } from "zod";

export const skillSourceSchema = z.enum([
  "plugin",
  "user",
  "project",
  "provider",
  "installed",
]);

export const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: skillSourceSchema,
  path: z.string(),
  enabled: z.boolean(),
});
export type Skill = z.infer<typeof skillSchema>;

export const registrySkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  install: z.string(),
  skill: z.string().optional(),
  url: z.string().optional(),
  installs: z.number().optional(),
});
export type RegistrySkill = z.infer<typeof registrySkillSchema>;

export interface SkillSource {
  id: string;
  label: string;
  search(query: string, signal: AbortSignal): Promise<RegistrySkill[]>;
}

const located = {
  projectId: z.string().optional(),
  hostId: z.string().optional(),
};
const target = z.object({
  id: z.string().min(1).describe("Skill id or name"),
  ...located,
});
const listInput = z.object(located);
const fromMachine = { hostId: "hostId" } as const;
const printList = (skills: Skill[]) =>
  skills
    .map(
      (skill) =>
        `${skill.enabled ? " " : "-"} ${skill.id}  ${skill.description ?? ""}`,
    )
    .join("\n");
const done = (verb: string) => (skill: Skill) => `${verb} ${skill.id}`;

export const machineSkillSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  enabled: z.boolean(),
});

export const skills = contract("skills", {
  list: op({
    input: listInput,
    output: z.array(skillSchema),
    doors: {
      http: { method: "GET", path: "/skills" },
      cli: {
        path: "skill list",
        summary: "List skills",
        from: fromMachine,
        print: printList,
      },
    },
  }),
  get: op({
    input: target,
    output: skillSchema.extend({
      content: z.string(),
      files: z.array(z.string()),
    }),
    doors: {
      http: { method: "GET", path: "/skills/:id" },
      cli: {
        path: "skill show",
        summary: "Print a skill's SKILL.md and files",
        positionals: ["id"],
        from: fromMachine,
        print: (skill) =>
          `${skill.content}\n\nfiles:\n${skill.files.join("\n")}`,
      },
    },
  }),
  install: op({
    input: z.object({
      source: z.string().min(1).describe("A git repository or a directory"),
      skill: z
        .string()
        .optional()
        .describe("The skill's directory name inside the source"),
      hostId: z.string().optional(),
    }),
    output: skillSchema,
    kind: "write",
    doors: {
      http: { method: "POST", path: "/skills", status: 201 },
      cli: {
        path: "skill install",
        summary: "Install a skill from a git repository or a directory",
        positionals: ["source", "skill"],
        from: fromMachine,
        print: done("Installed"),
      },
    },
  }),
  uninstall: op({
    input: target,
    output: skillSchema,
    kind: "write",
    doors: {
      http: { method: "DELETE", path: "/skills/:id" },
      cli: {
        path: "skill delete",
        aliases: ["skill remove"],
        summary: "Remove an installed skill",
        positionals: ["id"],
        from: fromMachine,
        print: done("Removed"),
      },
    },
  }),
  enable: op({
    input: target,
    output: skillSchema,
    kind: "write",
    doors: {
      http: { method: "POST", path: "/skills/:id/enable" },
      cli: {
        path: "skill enable",
        summary: "Offer a skill to agents again",
        positionals: ["id"],
        from: fromMachine,
        print: done("Enabled"),
      },
    },
  }),
  disable: op({
    input: target,
    output: skillSchema,
    kind: "write",
    doors: {
      http: { method: "POST", path: "/skills/:id/disable" },
      cli: {
        path: "skill disable",
        summary: "Stop offering a skill to agents",
        positionals: ["id"],
        from: fromMachine,
        print: done("Disabled"),
      },
    },
  }),
  search: op({
    input: z.object({ query: z.string().optional() }),
    output: z.array(registrySkillSchema.extend({ sourceId: z.string() })),
    doors: {
      http: { method: "GET", path: "/skills/registry" },
      cli: {
        path: "skill search",
        summary: "Search skill sources such as the registry",
        positionals: ["query"],
        print: (found) =>
          found
            .map((entry) => `${entry.id}  ${entry.description ?? ""}`)
            .join("\n"),
      },
    },
  }),
  source: slot<SkillSource>({ key: "id" }),
});

export const skillsMachine = contract("skillsMachine", {
  installed: op({
    input: z.object({}),
    output: z.object({
      root: z.string(),
      skills: z.array(machineSkillSchema),
    }),
    internal: true,
  }),
  scan: op({
    input: z.object({ roots: z.array(z.string()) }),
    output: z.array(machineSkillSchema),
    internal: true,
  }),
  read: op({
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string(), files: z.array(z.string()) }),
    internal: true,
  }),
  install: op({
    input: z.object({ source: z.string(), skill: z.string().optional() }),
    output: machineSkillSchema,
    kind: "write",
    internal: true,
  }),
  remove: op({
    input: z.object({ name: z.string() }),
    output: z.null(),
    kind: "write",
    internal: true,
  }),
  toggle: op({
    input: z.object({ name: z.string(), enabled: z.boolean() }),
    output: machineSkillSchema,
    kind: "write",
    internal: true,
  }),
});
