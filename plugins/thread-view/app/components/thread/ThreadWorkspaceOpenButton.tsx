import { useState } from "react";
import type { HostOpenTarget } from "@bb/server-contract";
import { SplitButton } from "../ui/split-button";
import { useAppCommandShortcut } from "@bb/app-kit/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@bb/app-kit/components/commands/AppCommandShortcutHint";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { Icon, type BuiltinIconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

const OPEN_TARGET_KIND_ICONS: Record<HostOpenTarget["kind"], BuiltinIconName> =
  {
    editor: "Code",
    "file-manager": "Folder",
    terminal: "Terminal",
  };

function OpenTargetGlyph({
  className,
  kind,
}: {
  className: string;
  kind: HostOpenTarget["kind"];
}) {
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
}: {
  onOpenTarget: (target: HostOpenTarget) => Promise<void>;
  preferredTarget: HostOpenTarget;
  targets: HostOpenTarget[];
}) {
  const [isPending, setIsPending] = useState(false);
  const shortcut = useAppCommandShortcut("workspace.openPreferred");
  const open = (target: HostOpenTarget) => () => {
    if (isPending) return;
    setIsPending(true);
    void onOpenTarget(target).finally(() => setIsPending(false));
  };
  const label = `Open workspace in ${preferredTarget.label}`;
  return (
    <span className="inline-flex items-center gap-1.5">
      <AppCommandShortcutHint shortcut={shortcut} />
      <SplitButton
        disabled={isPending}
        className={cn(
          "border-border/70 bg-transparent px-1 shadow-none",
          CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
        )}
        primaryAction={{
          ariaKeyshortcuts: shortcut?.ariaKeyshortcuts,
          label: shortcut ? `${label} (${shortcut.label})` : label,
          onSelect: open(preferredTarget),
          content: (
            <OpenTargetGlyph
              kind={preferredTarget.kind}
              className={cn("size-4", isPending && "animate-shine-icon")}
            />
          ),
        }}
        primaryTooltip={`Open in ${preferredTarget.label}`}
        secondaryActions={targets.map((target) => ({
          label: target.label,
          onSelect: open(target),
          content: (
            <>
              <OpenTargetGlyph kind={target.kind} className="size-5" />
              <span className="min-w-0 flex-1">{target.label}</span>
            </>
          ),
        }))}
        triggerLabel="Choose another app to open workspace"
        triggerTooltip="Choose another app"
        mobileTitle="Open Workspace"
      />
    </span>
  );
}
