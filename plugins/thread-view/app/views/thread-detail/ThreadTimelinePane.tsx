import type { ReactNode } from "react";
import { EmbeddedThreadChat } from "../../components/thread/embedded-chat";
import type { ThreadTimelineSurfaceProps } from "../../components/thread/timeline/ThreadTimelineSurface";

export function ThreadTimelinePane({
  footer,
  ...surface
}: ThreadTimelineSurfaceProps & { footer: ReactNode }) {
  return (
    <EmbeddedThreadChat
      variant="hosted-footer"
      footer={footer}
      surface={surface}
    />
  );
}
