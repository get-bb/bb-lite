import { fileURLToPath } from "node:url";

function inPackage(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

export const cliDir = inPackage(".");
export const bbCliPath = inPackage("bin/bb");
export const builtinSkillsDir = inPackage("skills");
export const guideDir = inPackage("guide");
