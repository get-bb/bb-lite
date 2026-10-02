import type { CSSProperties } from "react";
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
