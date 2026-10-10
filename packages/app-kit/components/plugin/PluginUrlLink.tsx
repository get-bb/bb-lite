import type { MouseEvent as ReactMouseEvent } from "react";
import type { UrlLinkProps } from "@bb/plugin/app";
import { RouteAnchor } from "../ui/app-route-anchor";
import { useAppNavigationHost } from "../../lib/url-open-routing";
import { resolveRouteHref } from "../../lib/route-paths";

export function PluginUrlLink({
  href,
  onClick,
  rel,
  target,
  ...anchorProps
}: UrlLinkProps) {
  const navigation = useAppNavigationHost();
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const plainClick =
      !event.defaultPrevented &&
      event.button === 0 &&
      !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
      !event.currentTarget.hasAttribute("download") &&
      !event.currentTarget.hasAttribute("target");
    const { origin } = window.location;
    if (
      plainClick &&
      resolveRouteHref({ currentOrigin: origin, href }) === null &&
      navigation.openUrl({ url: href })
    ) {
      event.preventDefault();
    }
  };
  if (target === undefined) {
    return (
      <RouteAnchor
        {...anchorProps}
        href={href}
        rel={rel}
        onClick={handleClick}
      />
    );
  }
  const opensWindow = !/^(|_self|_parent|_top)$/iu.test(target);
  return (
    <a
      {...anchorProps}
      href={href}
      target={target}
      rel={
        opensWindow && !/\bopener\b/iu.test(rel ?? "")
          ? `${rel ?? ""} noopener noreferrer`.trim()
          : rel
      }
      onClick={handleClick}
    />
  );
}
