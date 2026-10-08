import type { ComponentType, CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "../../lib/utils";
import * as ICON_MAP from "./icon-map";

export type BuiltinIconName = keyof typeof ICON_MAP;
export type IconName = string;

export interface IconProps {
  name: IconName;
  fallback?: string;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

type CustomIcon = ComponentType<{ className?: string; style?: CSSProperties }>;
const customIcons = new Map<string, CustomIcon>();

export function registerIcons(icons: Record<string, CustomIcon>): void {
  for (const [name, view] of Object.entries(icons)) customIcons.set(name, view);
}

export function isBuiltinIconName(name: string): name is BuiltinIconName {
  return Object.hasOwn(ICON_MAP, name);
}

export function Icon({
  name,
  fallback = "Zap",
  className,
  style,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  const Custom = customIcons.get(name);
  if (Custom !== undefined) {
    return (
      <span data-icon={name} data-icon-root="" className="contents">
        <Custom className={cn(className)} style={style} />
      </span>
    );
  }
  const resolved = isBuiltinIconName(name)
    ? name
    : isBuiltinIconName(fallback)
      ? fallback
      : "Zap";
  return (
    <HugeiconsIcon
      icon={ICON_MAP[resolved]}
      className={cn(className)}
      style={style}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={resolved}
      data-icon-root=""
    />
  );
}
