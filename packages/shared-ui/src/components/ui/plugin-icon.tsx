import { cn } from "../../lib/utils";

export function PluginCompactIconMask({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  const maskImage = `url(${JSON.stringify(url)})`;
  return (
    <span
      aria-hidden="true"
      data-plugin-icon-asset={url}
      data-icon-root=""
      className={cn("inline-block size-4 shrink-0", className)}
      style={{
        backgroundColor: "currentColor",
        maskImage,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: maskImage,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
      }}
    />
  );
}
