import { useRef } from "react";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import type { ProviderPromptActionCommand } from "@bb/client-core";

export interface PromptBoxAction {
  kind: "skills" | "goal";
  text: string;
  command?: ProviderPromptActionCommand;
}

const PROMPT_ACTIONS = [
  { kind: "skills", label: "Skills", icon: "Zap" },
] as const;

export function PromptBoxActionsMenu({
  actions = [],
  onAttach,
  onAction,
}: {
  actions?: readonly PromptBoxAction[];
  onAttach?: () => void;
  onAction: (action: PromptBoxAction) => void;
}) {
  const selectedItemRef = useRef(false);
  const visibleActions = PROMPT_ACTIONS.flatMap((presentation) => {
    const action = actions.find(
      (candidate) => candidate.kind === presentation.kind,
    );
    return action && action.text.length > 0 ? [{ action, presentation }] : [];
  });

  if (visibleActions.length === 0 && !onAttach) {
    return null;
  }

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          requestAnimationFrame(() => {
            selectedItemRef.current = false;
          });
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Prompt actions"
          className={cn(
            "size-auto h-8 px-2 transition-all",
            CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            "-ml-1.5",
          )}
        >
          <Icon name="Plus" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="Prompt actions"
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-36"
        onCloseAutoFocus={(event) => {
          if (selectedItemRef.current) {
            event.preventDefault();
          }
        }}
      >
        {onAttach ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                selectedItemRef.current = true;
                onAttach();
              }}
            >
              <Icon
                name="Paperclip"
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              Attach files
            </DropdownMenuItem>
            {visibleActions.length > 0 ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {visibleActions.map(({ action, presentation }) => (
          <DropdownMenuItem
            key={action.kind}
            onSelect={() => {
              selectedItemRef.current = true;
              onAction(action);
            }}
          >
            <Icon
              name={presentation.icon}
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            {presentation.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
