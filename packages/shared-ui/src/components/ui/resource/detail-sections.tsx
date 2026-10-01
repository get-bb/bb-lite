import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";

export type ResourceDetailSectionKind =
  | "overview"
  | "definition"
  | "configuration"
  | "release"
  | "includes"
  | "activity";

export interface ResourceDetailSectionProps {
  id?: string;
  className?: string;
  label: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function ResourceDetailSection({
  kind = "definition",
  id,
  className,
  label,
  actions,
  children,
}: ResourceDetailSectionProps & { kind?: ResourceDetailSectionKind }) {
  return (
    <section
      id={id}
      className={cn("space-y-3", className)}
      data-resource-detail-section={kind}
    >
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{label}</h2>
        {actions ? (
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function section(kind: ResourceDetailSectionKind) {
  function ResourceKindSection(props: ResourceDetailSectionProps) {
    return <ResourceDetailSection {...props} kind={kind} />;
  }
  ResourceKindSection.displayName = `Resource${kind[0]!.toUpperCase()}${kind.slice(1)}Section`;
  return ResourceKindSection;
}

export const ResourceDetailConfigurationSection = section("configuration");
