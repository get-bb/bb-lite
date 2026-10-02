import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pill } from "@bb/shared-ui/pill";
import { useRouteAnchorDelegate } from "@/components/ui/app-route-anchor";
import { PluginContext } from "./context";
import { isSlotCrashed, markSlotCrashed, slotInstanceKey } from "./registry";

interface BoundaryProps {
  pluginId: string;
  instanceKey: string;
  children: ReactNode;
  fallback?: ReactNode;
  onCrash?: (pluginId: string) => void;
}

class PluginSlotBoundary extends Component<
  BoundaryProps,
  { crashed: boolean }
> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const { pluginId, instanceKey, onCrash } = this.props;
    markSlotCrashed(instanceKey);
    console.warn(
      `[plugin:${pluginId}] slot "${instanceKey}" crashed and is disabled for this session: ${error.message}`,
      info.componentStack,
    );
    onCrash?.(pluginId);
  }

  override render(): ReactNode {
    const { pluginId, instanceKey, fallback, children } = this.props;
    if (!this.state.crashed && !isSlotCrashed(instanceKey)) return children;
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
  instanceId,
  onCrash,
}: {
  pluginId: string;
  slotKind: string;
  slotId: string;
  children: ReactNode;
  crashFallback?: ReactNode;
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
