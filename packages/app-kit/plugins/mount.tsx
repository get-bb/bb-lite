import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pill } from "@bb/shared-ui/pill";
import { useRouteAnchorDelegate } from "../components/ui/app-route-anchor";
import { PluginContext } from "./context";
import { isSlotCrashed, markSlotCrashed, slotInstanceKey } from "./registry";

interface BoundaryProps {
  pluginId: string;
  instanceKey: string;
  children: ReactNode;
  fallback?: ReactNode;
  resetKey?: string;
  onCrash?: (pluginId: string) => void;
}

interface BoundaryState {
  crashed: boolean;
  resetKey: string | undefined;
}

class PluginSlotBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { crashed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Pick<BoundaryState, "crashed"> {
    return { crashed: true };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): BoundaryState | null {
    if (props.resetKey === state.resetKey) return null;
    return { crashed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const { pluginId, instanceKey, resetKey, onCrash } = this.props;
    markSlotCrashed(instanceKey, resetKey);
    const until =
      resetKey === undefined ? "for this session" : "until its input changes";
    console.warn(
      `[plugin:${pluginId}] slot "${instanceKey}" crashed and is disabled ${until}: ${error.message}`,
      info.componentStack,
    );
    onCrash?.(pluginId);
  }

  override render(): ReactNode {
    const { pluginId, instanceKey, resetKey, fallback, children } = this.props;
    if (!this.state.crashed && !isSlotCrashed(instanceKey, resetKey)) {
      return children;
    }
    return fallback === undefined ? (
      <Pill variant="outline" className="text-muted-foreground">
        plugin {pluginId} crashed
      </Pill>
    ) : (
      fallback
    );
  }
}

export function PluginSlotMount({
  pluginId,
  slotKind,
  slotId,
  children,
  crashFallback,
  crashResetKey,
  instanceId,
  onCrash,
}: {
  pluginId: string;
  slotKind: string;
  slotId: string;
  children: ReactNode;
  crashFallback?: ReactNode;
  crashResetKey?: string;
  instanceId?: string;
  onCrash?: (pluginId: string) => void;
}) {
  const onRouteAnchorClick = useRouteAnchorDelegate();
  return (
    <PluginContext.Provider value={pluginId}>
      <PluginSlotBoundary
        pluginId={pluginId}
        instanceKey={slotInstanceKey(pluginId, slotKind, slotId, instanceId)}
        fallback={crashFallback}
        resetKey={crashResetKey}
        onCrash={onCrash}
      >
        <div
          data-bb-plugin={pluginId}
          className="contents"
          onClick={onRouteAnchorClick}
        >
          {children}
        </div>
      </PluginSlotBoundary>
    </PluginContext.Provider>
  );
}
