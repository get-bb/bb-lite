import type { ReactNode } from "react";
import { BottomAnchoredScrollBody } from "./bottom-anchored-scroll-body.js";
import { PAGE_SHELL_CONTENT_STYLE } from "./page-shell-content-style.js";
import { cn } from "@bb/shared-ui/lib/utils";
import { OverflowFade } from "./overflow-fade.js";

const SHELL_BLEED_CLASS =
  "-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5";
const MAX_WIDTH_CLASS = "max-w-[760px]";

export function PageShell({
  children,
  footer,
  shellClassName,
  contentClassName,
  footerClassName,
  scrollBehavior = "static",
}: {
  children: ReactNode;
  footer?: ReactNode;
  shellClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  scrollBehavior?: "bottom-anchor" | "static";
}) {
  const staticFooter = footer ? (
    <div className="relative shrink-0 bg-background">
      <OverflowFade placement="above" tone="background" />
      <div
        className={cn(
          "mx-auto w-full px-4 pb-4",
          MAX_WIDTH_CLASS,
          footerClassName,
        )}
      >
        {footer}
      </div>
    </div>
  ) : null;

  if (scrollBehavior === "bottom-anchor") {
    return (
      <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
        <BottomAnchoredScrollBody
          contentClassName={contentClassName}
          maxWidthClassName={MAX_WIDTH_CLASS}
          footer={staticFooter}
        >
          {children}
        </BottomAnchoredScrollBody>
      </div>
    );
  }

  return (
    <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="@container/page min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              "mx-auto flex w-full flex-col px-4 pb-4 pt-2",
              MAX_WIDTH_CLASS,
              contentClassName,
            )}
            style={PAGE_SHELL_CONTENT_STYLE}
          >
            {children}
          </div>
        </div>
        {staticFooter}
      </div>
    </div>
  );
}
