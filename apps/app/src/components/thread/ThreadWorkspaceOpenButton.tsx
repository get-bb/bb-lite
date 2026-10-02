import { useCallback, useState } from "react";
import type { HostOpenTarget } from "@bb/server-contract";
import {
  SplitButton,
  type SplitButtonAction,
} from "@/components/ui/split-button.js";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { Icon, type BuiltinIconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

interface ThreadWorkspaceOpenButtonProps {
  onOpenTarget: (target: HostOpenTarget) => Promise<void>;
  preferredTarget: HostOpenTarget;
  targets: HostOpenTarget[];
}

interface OpenTargetGlyphProps {
  className: string;
  kind: HostOpenTarget["kind"];
}

const OPEN_TARGET_KIND_ICONS: Record<HostOpenTarget["kind"], BuiltinIconName> =
  {
    editor: "Code",
    "file-manager": "Folder",
    terminal: "Terminal",
  };

function OpenTargetGlyph({ className, kind }: OpenTargetGlyphProps) {
  return (
    <span
      className={cn(
        className,
        "flex shrink-0 items-center justify-center text-muted-foreground",
      )}
    >
      <Icon
        name={OPEN_TARGET_KIND_ICONS[kind]}
        className="!size-3.5"
        aria-hidden
      />
    </span>
  );
}

export function ThreadWorkspaceOpenButton({
  onOpenTarget,
  preferredTarget,
  targets,
}: ThreadWorkspaceOpenButtonProps) {
  const [isPending, setIsPending] = useState(false);
  const shortcut = useAppCommandShortcut("workspace.openPreferred");

  const openTarget = useCallback(
    async (target: HostOpenTarget) => {
      if (isPending) {
        return;
      }

      setIsPending(true);
      try {
        await onOpenTarget(target);
      } finally {
        setIsPending(false);
      }
    },
    [isPending, onOpenTarget],
  );

  const primaryAction: SplitButtonAction = {
    ariaKeyshortcuts: shortcut?.ariaKeyshortcuts,
    label: shortcut
      ? `Open workspace in ${preferredTarget.label} (${shortcut.label})`
      : `Open workspace in ${preferredTarget.label}`,
    onSelect: () => {
      void openTarget(preferredTarget);
    },
    content: (
      <OpenTargetGlyph
        kind={preferredTarget.kind}
        className={cn("size-4", isPending && "animate-shine-icon")}
      />
    ),
  };
  const secondaryActions: SplitButtonAction[] = targets.map((target) => ({
    label: target.label,
    onSelect: () => {
      void openTarget(target);
    },
    content: (
      <>
        <OpenTargetGlyph kind={target.kind} className="size-5" />
        <span className="min-w-0 flex-1">{target.label}</span>
      </>
    ),
  }));

  return (
    <span className="inline-flex items-center gap-1.5">
      <AppCommandShortcutHint shortcut={shortcut} />
      <SplitButton
        disabled={isPending}
        className={cn(
          "border-border/70 bg-transparent px-1 shadow-none",
          CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
        )}
        primaryAction={primaryAction}
        primaryTooltip={`Open in ${preferredTarget.label}`}
        secondaryActions={secondaryActions}
        triggerLabel="Choose another app to open workspace"
        triggerTooltip="Choose another app"
      />
    </span>
  );
}
