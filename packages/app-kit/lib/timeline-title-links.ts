import type { TimelineTitleLink } from "@bb/thread-view";

export type TimelineTitleLinkResolver = (
  link: TimelineTitleLink,
) => string | null;
