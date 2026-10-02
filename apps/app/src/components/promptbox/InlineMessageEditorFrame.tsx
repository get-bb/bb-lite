import type { ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";

export function InlineMessageEditorFrame({
  cancelLabel,
  children,
  label,
  onCancel,
}: {
  cancelLabel: string;
  children: ReactNode;
  label: string;
  onCancel: () => void;
}) {
  return (
    <div className="relative z-20" data-inline-message-editor-frame="embedded">
      <div className="flex min-h-7 items-center gap-1.5 text-xs text-subtle-foreground mb-1.5 pl-1">
        <Icon name="Edit" className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">{label}</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="ml-auto size-6 shrink-0 text-subtle-foreground"
          onClick={onCancel}
          aria-label={cancelLabel}
        >
          <Icon name="X" className="size-3" aria-hidden />
        </Button>
      </div>
      {children}
    </div>
  );
}
