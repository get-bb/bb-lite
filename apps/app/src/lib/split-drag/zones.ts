import type { SplitSide } from "@/lib/split-layout";

export type SplitZone = SplitSide | "center";

export interface ZoneDecision {
  zone: SplitZone;
  label: string;
}

interface ThreadDropInput {
  zone: SplitZone;
  threadAlreadyOpen: boolean;
  atMaxPanes: boolean;
}

export function decideThreadDrop({
  zone,
  threadAlreadyOpen,
  atMaxPanes,
}: ThreadDropInput): ZoneDecision {
  if (threadAlreadyOpen) {
    return { zone: "center", label: "Already open — focus pane" };
  }
  if (atMaxPanes) {
    return { zone: "center", label: "Replace this chat" };
  }
  return {
    zone,
    label: zone === "center" ? "Replace this chat" : `Split ${zone}`,
  };
}
