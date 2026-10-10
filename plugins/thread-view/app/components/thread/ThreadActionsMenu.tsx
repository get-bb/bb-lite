import { ActionMenuItem, ActionMenuSeparator } from "../ui/action-menu-items";
import type { Thread } from "@bb/domain";
import {
  shell,
  type ThreadAction,
  type ThreadActionChoice,
  type ThreadActionContext,
} from "@bb/plugin/app";
import { Fragment, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { cn } from "@bb/shared-ui/lib/utils";
import { useSlot } from "@bb/app-kit/plugins/slots";
import { useThreadActions } from "@bb/app-kit/components/thread/ThreadActionsProvider";

export interface ThreadActionsMenuResponsiveAction {
  icon: IconName;
  label: string;
  onSelect: () => void | Promise<void>;
}

const UNORDERED = 1_000;
const DEFAULT_GROUP = "";

function grouped(
  actions: readonly ThreadAction[],
  context: ThreadActionContext,
): ThreadAction[][] {
  const sorted = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.isAvailable?.(context) ?? true)
    .sort(
      (a, b) =>
        (a.action.order ?? UNORDERED) - (b.action.order ?? UNORDERED) ||
        a.index - b.index,
    );
  const groups = new Map<string, ThreadAction[]>();
  for (const { action } of sorted) {
    const group = action.group ?? DEFAULT_GROUP;
    groups.set(group, [...(groups.get(group) ?? []), action]);
  }
  return [...groups.values()];
}

function resolve(
  value: string | ((context: ThreadActionContext) => string),
  context: ThreadActionContext,
): string {
  return typeof value === "string" ? value : value(context);
}

function ThreadActionChoices({
  choices,
  drawerStep = false,
  icon,
  isDrawer,
  label,
  onBack,
  onOpenDrawerStep,
}: {
  choices: readonly ThreadActionChoice[];
  drawerStep?: boolean;
  icon: IconName;
  isDrawer: boolean;
  label: string;
  onBack?: () => void;
  onOpenDrawerStep?: () => void;
}) {
  const items = choices.map((choice) => (
    <DropdownMenuItem
      key={choice.id}
      aria-current={choice.isCurrent ? "true" : undefined}
      className="flex items-center justify-between gap-3"
      disabled={choice.isCurrent}
      onSelect={() => {
        void choice.run();
      }}
    >
      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
      {choice.isCurrent ? (
        <Icon name="Check" className="ml-auto" aria-hidden="true" />
      ) : null}
    </DropdownMenuItem>
  ));
  if (isDrawer) {
    if (!drawerStep) {
      return (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onOpenDrawerStep?.();
          }}
        >
          <Icon name={icon} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <Icon name="ChevronRight" className="ml-auto" aria-hidden="true" />
        </DropdownMenuItem>
      );
    }
    return (
      <>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onBack?.();
          }}
        >
          <Icon name="ChevronLeft" aria-hidden="true" />
          Back
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {items}
      </>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon name={icon} aria-hidden="true" />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[min(24rem,calc(100vh-2rem))] min-w-44 overflow-y-auto">
        {items}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function ThreadActionsMenu({
  thread,
  responsiveActions = [],
  triggerClassName,
}: {
  thread: Thread;
  triggerClassName?: string;
  responsiveActions?: readonly ThreadActionsMenuResponsiveAction[];
}) {
  const actions = useThreadActions();
  const registered = useSlot(shell.threadAction);
  const isDrawer = useIsCompactViewport();
  const [compactStep, setCompactStep] = useState<string | null>(null);
  const context: ThreadActionContext = { thread, actions };
  const groups = grouped(registered, context);
  const stepAction = isDrawer
    ? groups.flat().find((action) => action.id === compactStep)
    : undefined;
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setCompactStep(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0",
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
            triggerClassName,
          )}
          aria-label="Thread actions"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon
            name="MoreHorizontal"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {stepAction?.choices !== undefined ? (
          <ThreadActionChoices
            choices={stepAction.choices(context)}
            drawerStep
            icon={resolve(stepAction.icon, context) as IconName}
            isDrawer
            label={resolve(stepAction.label, context)}
            onBack={() => setCompactStep(null)}
          />
        ) : (
          <>
            {responsiveActions.map((action) => (
              <ActionMenuItem
                key={action.label}
                icon={action.icon}
                onSelect={() => {
                  void action.onSelect();
                }}
              >
                {action.label}
              </ActionMenuItem>
            ))}
            {groups.map((group, groupIndex) => (
              <Fragment key={group[0]?.id}>
                {(groupIndex > 0 || responsiveActions.length > 0) &&
                !isDrawer ? (
                  <ActionMenuSeparator />
                ) : null}
                {group.map((action) => {
                  const icon = resolve(action.icon, context) as IconName;
                  const label = resolve(action.label, context);
                  if (action.choices !== undefined) {
                    return (
                      <ThreadActionChoices
                        key={action.id}
                        choices={action.choices(context)}
                        icon={icon}
                        isDrawer={isDrawer}
                        label={label}
                        onOpenDrawerStep={() => setCompactStep(action.id)}
                      />
                    );
                  }
                  return (
                    <ActionMenuItem
                      key={action.id}
                      icon={icon}
                      variant={action.variant}
                      onSelect={() => {
                        void action.run(context);
                      }}
                    >
                      {label}
                    </ActionMenuItem>
                  );
                })}
              </Fragment>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
