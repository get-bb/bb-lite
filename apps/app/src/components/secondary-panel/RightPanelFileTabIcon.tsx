import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon, type IconName } from "@bb/shared-ui/icon";

export function resolveRightPanelFileIconName(path: string): IconName {
  const segments = path.toLowerCase().split("/");
  const name = segments.pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  const extension = dotIndex <= 0 ? "" : name.slice(dotIndex + 1);
  const isMarkdown = extension === "md" || extension === "markdown";
  const isHtml = extension === "html" || extension === "htm";
  if (segments.includes("reports") && (isMarkdown || isHtml)) {
    return "ChartColumn";
  }
  return isMarkdown ? "File" : isHtml ? "AppWindow" : "Code";
}

export function RightPanelFileTabIcon({ path }: { path: string }) {
  return (
    <Icon
      name={resolveRightPanelFileIconName(path)}
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
      aria-hidden
    />
  );
}
