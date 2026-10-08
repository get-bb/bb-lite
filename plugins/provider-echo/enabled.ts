export function echoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST === "true") return true;
  return (env.BB_DEV_PROVIDERS ?? "").split(",").includes("echo");
}
