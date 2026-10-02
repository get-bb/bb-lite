export function normalizeAbsoluteFilePath({
  path,
}: {
  path: string;
}): string | null {
  if (!path.startsWith("/")) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment.length > 0 && segment !== ".") segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function isAbsoluteFilePathWithinRoot(args: {
  candidatePath: string;
  rootPath: string;
}): boolean {
  const candidate = normalizeAbsoluteFilePath({ path: args.candidatePath });
  const root = normalizeAbsoluteFilePath({ path: args.rootPath });
  return (
    candidate !== null &&
    root !== null &&
    (root === "/" || candidate === root || candidate.startsWith(`${root}/`))
  );
}

export function buildAbsoluteFilePath(args: {
  path: string;
  rootPath: string;
}): string {
  if (args.path.startsWith("/")) return args.path;
  const root = args.rootPath === "/" ? "" : args.rootPath.replace(/\/+$/u, "");
  return `${root}/${args.path}`;
}

export function resolveAbsoluteFilePath(args: {
  path: string;
  rootPath: string | null | undefined;
}): string | null {
  if (args.path.startsWith("/")) return args.path;
  return args.rootPath
    ? buildAbsoluteFilePath({ path: args.path, rootPath: args.rootPath })
    : null;
}

export function getAbsoluteDirname({ path }: { path: string }): string {
  const trimmed = path === "/" ? path : path.replace(/\/+$/u, "");
  const lastSlashIndex = trimmed.lastIndexOf("/");
  return lastSlashIndex <= 0 ? "/" : trimmed.slice(0, lastSlashIndex);
}
