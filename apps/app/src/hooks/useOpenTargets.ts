import { useCallback, useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import type { HostOpenTarget } from "@bb/server-contract";
import { appToast } from "@/components/ui/app-toast";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { rawStringLocalStorage } from "@/lib/browser-storage";
import { isLoopbackHostname } from "@/lib/loopback-hostname";
import { sdk } from "@/lib/sdk";

interface OpenPathRequest {
  lineNumber: number | null;
  path: string;
}

type OpenCapability = keyof HostOpenTarget["capabilities"];

const NO_OPEN_TARGETS: HostOpenTarget[] = [];
const OPEN_TARGETS_STALE_TIME_MS = 60_000;

const lastOpenTargetIdAtomFamily = atomFamily((hostId: string) =>
  atomWithStorage<string>(
    `bb.openTarget.${hostId}`,
    "",
    rawStringLocalStorage,
    { getOnInit: true },
  ),
);

function preferTarget(
  targets: HostOpenTarget[],
  capability: OpenCapability,
  lastTargetId: string,
): HostOpenTarget | null {
  const capable = targets.filter((target) => target.capabilities[capability]);
  return (
    capable.find((target) => target.id === lastTargetId) ?? capable[0] ?? null
  );
}

export function useLocalHostId(): string | null {
  const primaryHostId = useSystemConfig().data?.primaryHostId ?? null;
  return isLoopbackHostname(window.location.hostname) ? primaryHostId : null;
}

export function useOpenTargets(hostId: string | null) {
  const localHostId = useLocalHostId();
  const openHostId = hostId !== null && hostId === localHostId ? hostId : null;
  const { data } = useQuery({
    queryKey: ["hostOpenTargets", openHostId],
    queryFn:
      openHostId === null
        ? skipToken
        : ({ signal }) => sdk.hosts.openTargets({ hostId: openHostId, signal }),
    staleTime: OPEN_TARGETS_STALE_TIME_MS,
  });
  const targets = data?.targets ?? NO_OPEN_TARGETS;
  const [lastTargetId, setLastTargetId] = useAtom(
    lastOpenTargetIdAtomFamily(openHostId ?? ""),
  );
  const directoryTargets = useMemo(
    () => targets.filter((target) => target.capabilities.openDirectory),
    [targets],
  );
  const fileTargets = useMemo(
    () => targets.filter((target) => target.capabilities.openFile),
    [targets],
  );
  const preferredDirectoryTarget = useMemo(
    () => preferTarget(targets, "openDirectory", lastTargetId),
    [lastTargetId, targets],
  );
  const preferredFileTarget = useMemo(
    () =>
      preferTarget(targets, "openFileAtLine", lastTargetId) ??
      preferTarget(targets, "openFile", lastTargetId),
    [lastTargetId, targets],
  );
  const openPath = useCallback(
    async (target: HostOpenTarget, request: OpenPathRequest) => {
      if (openHostId === null) {
        return;
      }
      setLastTargetId(target.id);
      const line = target.capabilities.openFileAtLine
        ? request.lineNumber
        : null;
      try {
        await sdk.hosts.open({
          hostId: openHostId,
          targetId: target.id,
          path: request.path,
          ...(line === null ? {} : { line }),
        });
      } catch (error) {
        appToast.error("Failed to open file locally", {
          ...(error instanceof Error ? { description: error.message } : {}),
        });
      }
    },
    [openHostId, setLastTargetId],
  );
  const openInPreferredFileTarget = useMemo(
    () =>
      preferredFileTarget
        ? (request: OpenPathRequest) =>
            void openPath(preferredFileTarget, request)
        : undefined,
    [openPath, preferredFileTarget],
  );

  return {
    directoryTargets,
    fileTargets,
    openInPreferredFileTarget,
    openPath,
    preferredDirectoryTarget,
  };
}
