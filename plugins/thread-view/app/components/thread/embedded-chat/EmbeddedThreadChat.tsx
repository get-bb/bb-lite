import type { ReactNode } from "react";
import {
  ThreadTimelineSurface,
  type ThreadTimelineSurfaceProps,
} from "../timeline";
import { PageShell } from "@bb/app-kit/components/ui/page-shell";

export function EmbeddedThreadChat({
  footer,
  surface,
}: {
  variant: "hosted-footer";
  footer: ReactNode;
  surface: ThreadTimelineSurfaceProps;
}) {
  return (
    <div
      data-thread-window=""
      className="flex h-full min-h-0 min-w-0 flex-col overflow-clip"
    >
      <PageShell
        key={surface.threadId}
        scrollBehavior="bottom-anchor"
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="gap-2 pt-4"
        footerClassName="chat-prompt-box"
        footer={footer}
      >
        <ThreadTimelineSurface {...surface} />
      </PageShell>
    </div>
  );
}
