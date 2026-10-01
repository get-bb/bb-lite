import type { ExperimentalProviderIconProps } from "@get-bb/plugin-sdk/app";
import { isPresentationTintColor } from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export function ProviderIcon({
  provider,
  fallback = "Code",
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: Omit<ExperimentalProviderIconProps, "providerKind">) {
  "use no memo";
  const { logoUrl, icon } = provider;
  const glyph = typeof icon === "string" ? icon : icon?.glyph;
  const tint = provider.strings?.iconTint;
  const image =
    logoUrl == null
      ? undefined
      : `url("${logoUrl.replace(/["\\]/gu, "\\$&")}")`;
  return (
    <span
      className={cn(
        "inline-flex size-6 min-h-max min-w-max shrink-0 items-center justify-center",
        className,
      )}
      style={
        tint != null &&
        isPresentationTintColor(tint.light) &&
        isPresentationTintColor(tint.dark)
          ? { color: `light-dark(${tint.light.trim()}, ${tint.dark.trim()})` }
          : undefined
      }
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden ?? (ariaLabel ? undefined : true)}
    >
      {image === undefined ? (
        <Icon
          name={glyph ?? fallback}
          fallback={fallback}
          className="size-full"
          aria-hidden="true"
        />
      ) : (
        <span
          data-provider-logo={logoUrl}
          className="inline-block size-full shrink-0 bg-current"
          style={{
            maskImage: image,
            WebkitMaskImage: image,
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskSize: "contain",
            WebkitMaskSize: "contain",
          }}
        />
      )}
    </span>
  );
}
