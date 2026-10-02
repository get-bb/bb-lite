import { loginShellPath, scrubEnv } from "../sessions/agent-env.js";

export type ChildEnv = () => Promise<NodeJS.ProcessEnv>;

export function scrubbedProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return scrubEnv(source);
}

export function createLoginShellChildEnv(
  extra: Record<string, string> = {},
  pathPrefix: string | null = null,
): ChildEnv {
  return async () => {
    const env = scrubbedProcessEnv();
    const inherited = (await loginShellPath()) ?? env.PATH ?? "";
    const path = pathPrefix ? `${pathPrefix}:${inherited}` : inherited;
    return { ...env, ...extra, PATH: path };
  };
}
