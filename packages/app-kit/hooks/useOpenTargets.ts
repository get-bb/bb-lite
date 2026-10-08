import { skipToken, useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import type { HostOpenTarget } from "@bb/server-contract";
import { appToast } from "../components/ui/app-toast";
import { useSystemConfig } from "./queries/system-queries";
import { rawStringLocalStorage } from "../lib/browser-storage";
import { isLoopbackHostname } from "../lib/loopback-hostname";
import { sdk } from "../lib/sdk";

interface OpenPathRequest {
  lineNumber: number | null;
  path: string;
}

const NO_OPEN_TARGETS: HostOpenTarget[] = [];

const lastOpenTargetIdAtomFamily = atomFamily((hostId: string) =>
  atomWithStorage<string>(
    `bb.openTarget.${hostId}`,
    "",
    rawStringLocalStorage,
    { getOnInit: true },
  ),
);

async function openOnHost(
  hostId: string,
  target: HostOpenTarget,
  request: OpenPathRequest,
): Promise<void> {
  const line = target.capabilities.openFileAtLine ? request.lineNumber : null;
  try {
    await sdk.hosts.open({
      hostId,
      targetId: target.id,
      path: request.path,
      ...(line === null ? {} : { line }),
    });
  } catch (error) {
    appToast.error("Failed to open file locally", {
      ...(error instanceof Error ? { description: error.message } : {}),
    });
  }
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
    staleTime: 60_000,
  });
  const targets = data?.targets ?? NO_OPEN_TARGETS;
  const [lastTargetId, setLastTargetId] = useAtom(
    lastOpenTargetIdAtomFamily(openHostId ?? ""),
  );
  const capableOf = (capability: keyof HostOpenTarget["capabilities"]) =>
    targets.filter((target) => target.capabilities[capability]);
  const preferred = (capability: keyof HostOpenTarget["capabilities"]) => {
    const capable = capableOf(capability);
    return (
      capable.find((target) => target.id === lastTargetId) ?? capable[0] ?? null
    );
  };
  const openPath = async (target: HostOpenTarget, request: OpenPathRequest) => {
    if (openHostId === null) return;
    setLastTargetId(target.id);
    await openOnHost(openHostId, target, request);
  };
  const fileTarget = preferred("openFileAtLine") ?? preferred("openFile");
  return {
    directoryTargets: capableOf("openDirectory"),
    fileTargets: capableOf("openFile"),
    openInPreferredFileTarget: fileTarget
      ? (request: OpenPathRequest) => void openPath(fileTarget, request)
      : undefined,
    openPath,
    preferredDirectoryTarget: preferred("openDirectory"),
  };
}
