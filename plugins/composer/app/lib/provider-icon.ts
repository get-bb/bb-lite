import { createElement, type ComponentType } from "react";
import { ProviderIcon } from "@bb/app-kit/components/plugin/ProviderIcon";

type IconComponent = ComponentType<{ className?: string }>;

const providerIcons = new Map<string, IconComponent>();

export function getProviderIconInfo(
  providerId: string,
  source: { logoUrl: string | null; icon?: { glyph: string } },
): { icon: IconComponent } {
  const { logoUrl, icon: glyphIcon } = source;
  const cacheKey = JSON.stringify([providerId, logoUrl, glyphIcon?.glyph]);
  let icon = providerIcons.get(cacheKey);
  if (icon === undefined) {
    const provider = { id: providerId, logoUrl, icon: glyphIcon };
    icon = ({ className }) =>
      createElement(ProviderIcon, { provider, className });
    providerIcons.set(cacheKey, icon);
  }
  return { icon };
}
