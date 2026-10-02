export function rewriteLocalhostLinkHref(args: {
  currentHostname: string | undefined;
  enabled: boolean;
  href: string | undefined;
}): string | undefined {
  const { currentHostname, href } = args;
  if (
    !args.enabled ||
    href === undefined ||
    currentHostname === undefined ||
    /^(?:.+\.)?getbb\.app$/iu.test(currentHostname)
  ) {
    return href;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const isLoopbackLink =
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["127.0.0.1", "localhost"].includes(url.hostname.toLowerCase());
  if (!isLoopbackLink || url.hostname === currentHostname) return href;
  url.hostname = currentHostname;
  return url.toString();
}
