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
import { composer, type ComposerContext } from "@bb/plugin/app";
import { Fragment, useRef } from "react";
import { useComposerItems } from "./composer-slots";

export interface PromptBoxAction {
  kind: "skills" | "goal";
  text: string;
  command?: ProviderPromptActionCommand;
}

const DEFAULT_GROUP = "actions";

export function PromptBoxActionsMenu({
  context,
}: {
  context: ComposerContext;
}) {
  const selectedItemRef = useRef(false);
  const items = useComposerItems(composer.menuItem, context);

  if (items.length === 0) {
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
        mobileTitle="Prompt actions"
        className="w-36"
        onCloseAutoFocus={(event) => {
          if (selectedItemRef.current) {
            event.preventDefault();
          }
        }}
      >
        {items.map((item, index) => {
          const previous = items[index - 1];
          const startsGroup =
            previous !== undefined &&
            (previous.group ?? DEFAULT_GROUP) !== (item.group ?? DEFAULT_GROUP);
          return (
            <Fragment key={item.id}>
              {startsGroup ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                onSelect={() => {
                  selectedItemRef.current = true;
                  item.run(context);
                }}
              >
                <Icon
                  name={item.icon as IconName}
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                {item.label}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
