import { PluginCompactIconMask } from "@bb/shared-ui/plugin-icon";
import { Icon, isBuiltinIconName, type IconName } from "@bb/shared-ui/icon";
import { usePluginCompactBranding } from "@/lib/plugin-logos";
import { cn } from "@bb/shared-ui/lib/utils";

export function pluginIconName(icon: string | null): IconName {
  return icon ?? "Zap";
}

export function PluginIcon({
  pluginId,
  icon,
  compactIconUrl,
  fallbackIcon = "Zap",
  className,
}: {
  pluginId: string;
  icon: string | null;
  compactIconUrl?: string | null;
  fallbackIcon?: IconName | null;
  className?: string;
}) {
  const branding = usePluginCompactBranding(pluginId);
  const url =
    compactIconUrl === undefined ? branding?.compactIconUrl : compactIconUrl;
  const name = branding?.icon ?? icon ?? fallbackIcon;
  return url ? (
    <PluginCompactIconMask url={url} className={className} />
  ) : name === null ? null : (
    <Icon
      name={name}
      className={cn("size-4 shrink-0", className)}
      aria-hidden="true"
    />
  );
}

export function PluginItemIcon({
  pluginId,
  icon,
  className,
}: {
  pluginId: string;
  icon: string | null;
  className?: string;
}) {
  return icon !== null && isBuiltinIconName(icon) ? (
    <Icon
      name={icon}
      className={cn("size-4 shrink-0", className)}
      aria-hidden
    />
  ) : (
    <PluginIcon pluginId={pluginId} icon={null} className={className} />
  );
}
