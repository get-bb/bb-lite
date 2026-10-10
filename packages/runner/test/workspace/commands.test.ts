import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { createHarness } from "./harness.js";

const h = createHarness();
afterAll(() => h.dispose());

it("lists skills from a provider's native skill roots", async () => {
  const skill = (name: string) =>
    `---\nname: ${name}\ndescription: ${name}\n---\n`;
  const repo = h.initRepo("native", {
    ".pi/skills/project-pi/SKILL.md": skill("project-pi"),
  });
  h.write(h.root, { "pi-user/user-pi/SKILL.md": skill("user-pi") });
  const nativeSkillRoots = {
    user: [path.join(h.root, "pi-user")],
    project: [".pi/skills"],
  };
  const scope = { providerId: "pi", cwd: repo };
  const listed = await h.api.listCommands({ ...scope, nativeSkillRoots });
  const names = listed.commands.map(({ name, origin }) => `${origin}:${name}`);
  expect(names).toContain("project:project-pi");
  expect(names).toContain("user:user-pi");
  const plain = await h.api.listCommands(scope);
  expect(plain.commands.map(({ name }) => name)).not.toContain("project-pi");
});
