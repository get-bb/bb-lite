import { useCallback, useRef } from "react";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import type { ProviderPromptActionCommand } from "@bb/client-core";

type PromptBoxActionKind = "skills" | "plan" | "goal";

export interface PromptBoxAction {
  kind: PromptBoxActionKind;
  text: string;
  command?: ProviderPromptActionCommand;
}

interface PromptBoxActionsMenuProps {
  actions?: readonly PromptBoxAction[];
  onAttach?: () => void;
  onAction: (action: PromptBoxAction) => void;
}

const PROMPT_ACTION_PRESENTATION = {
  skills: {
    label: "Skills",
    icon: "Zap",
  },
  plan: {
    label: "Plan",
    icon: "ListTodo",
  },
  goal: {
    label: "Goal",
    icon: "Target",
  },
} as const satisfies Record<
  PromptBoxActionKind,
  { label: string; icon: IconName }
>;

const PROMPT_ACTION_ORDER: readonly PromptBoxActionKind[] = [
  "skills",
  "plan",
  "goal",
];

function orderedPromptActions(
  actions: readonly PromptBoxAction[],
): PromptBoxAction[] {
  return PROMPT_ACTION_ORDER.flatMap((kind) => {
    const action = actions.find((candidate) => candidate.kind === kind);
    return action ? [action] : [];
  });
}

export function PromptBoxActionsMenu({
  actions = [],
  onAttach,
  onAction,
}: PromptBoxActionsMenuProps) {
  const selectedItemRef = useRef(false);
  const visibleActions = orderedPromptActions(actions).filter(
    (action) => action.text.length > 0,
  );
  const clearSelectedActionAfterClose = useCallback(() => {
    const clear = () => {
      selectedItemRef.current = false;
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(clear);
      return;
    }
    setTimeout(clear, 0);
  }, []);

  if (visibleActions.length === 0 && !onAttach) {
    return null;
  }

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          clearSelectedActionAfterClose();
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
            COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
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
        {visibleActions.map((action) => {
          const presentation = PROMPT_ACTION_PRESENTATION[action.kind];
          return (
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
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
