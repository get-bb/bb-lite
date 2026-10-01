import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pill } from "@bb/shared-ui/pill";
import { useRouteAnchorDelegate } from "@/components/ui/app-route-anchor";
import { PluginContext } from "./context";
import { isSlotCrashed, markSlotCrashed, slotInstanceKey } from "./registry";

interface PluginSlotBoundaryProps {
  pluginId: string;
  instanceKey: string;
  children: ReactNode;
  fallback?: ReactNode;
  onCrash?: (pluginId: string) => void;
}

class PluginSlotBoundary extends Component<
  PluginSlotBoundaryProps,
  { crashed: boolean }
> {
  override state = { crashed: isSlotCrashed(this.props.instanceKey) };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    markSlotCrashed(this.props.instanceKey);
    console.warn(
      `[plugin:${this.props.pluginId}] slot "${this.props.instanceKey}" crashed and is disabled for this session: ${error.message}`,
      info.componentStack,
    );
    try {
      this.props.onCrash?.(this.props.pluginId);
    } catch (notifyError) {
      console.warn(
        `[plugin:${this.props.pluginId}] slot crash notifier failed`,
        notifyError,
      );
    }
  }

  override render(): ReactNode {
    if (this.state.crashed || isSlotCrashed(this.props.instanceKey)) {
      return this.props.fallback === undefined ? (
        <Pill variant="outline" className="text-muted-foreground">
          plugin {this.props.pluginId} crashed
        </Pill>
      ) : (
        this.props.fallback
      );
    }
    return this.props.children;
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
        {...(onCrash ? { onCrash } : {})}
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
