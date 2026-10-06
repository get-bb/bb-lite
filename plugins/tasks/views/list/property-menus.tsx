import { useState, type ReactNode } from "react";
import {
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { PriorityIcon, StatusIcon } from "./icons.js";
import { PRIORITY_LABELS, STATUS_LABELS } from "./lib.js";

const PRIORITY_MENU_ORDER: readonly TaskPriority[] = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
];
const TRIGGER_CLASS =
  "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-state-active focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active max-md:pointer-coarse:size-8";
const SHORTCUT_CLASS =
  "w-3 text-right text-2xs tabular-nums text-subtle-foreground";

export function isBareKey(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

interface EditorProps<Value extends string> {
  value: Value;
  onSelect: (value: Value) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  labelled?: boolean;
}

export interface EditorKind<Value extends string> {
  values: readonly Value[];
  labels: Readonly<Record<Value, string>>;
  icon: (value: Value) => ReactNode;
  heading: string;
  mobileTitle?: string;
  letter: string;
  firstShortcut: number;
  width: string;
}

export function PropertyEditor<Value extends string>({
  value,
  onSelect,
  open,
  onOpenChange,
  className,
  labelled = false,
  kind,
}: EditorProps<Value> & { kind: EditorKind<Value> }) {
  const [innerOpen, setInnerOpen] = useState(false);
  const setOpen = onOpenChange ?? setInnerOpen;
  const select = (next: Value | undefined) => {
    if (next !== undefined && next !== value) onSelect(next);
  };
  const current = kind.labels[value];
  return (
    <DropdownMenu open={open ?? innerOpen} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {labelled ? (
          <button type="button" className={className}>
            {kind.icon(value)}
            {current}
          </button>
        ) : (
          <button
            type="button"
            aria-label={`${kind.heading.replace(/( to)?…$/u, "")}, currently ${current}`}
            className={cn(TRIGGER_CLASS, className)}
          >
            {kind.icon(value)}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={kind.width}
        mobileTitle={kind.mobileTitle}
        onKeyDown={(event) => {
          if (!/^[0-9]$/.test(event.key) || !isBareKey(event)) return;
          const index = Number(event.key) - kind.firstShortcut;
          if (kind.values[index] === undefined) return;
          event.preventDefault();
          select(kind.values[index]);
          setOpen(false);
        }}
      >
        <DropdownMenuLabel className="flex items-center gap-2">
          <span className="flex-1">{kind.heading}</span>
          <span className={SHORTCUT_CLASS}>{kind.letter}</span>
        </DropdownMenuLabel>
        {kind.values.map((option, index) => (
          <DropdownMenuItem
            key={option}
            aria-current={option === value ? "true" : undefined}
            onSelect={() => select(option)}
          >
            <span className="flex flex-1 items-center gap-2">
              {kind.icon(option)}
              {kind.labels[option]}
              {option === value ? (
                <span className="sr-only"> (current)</span>
              ) : null}
            </span>
            <span
              aria-hidden
              className="flex w-4 items-center justify-center text-subtle-foreground"
            >
              {option === value ? (
                <Icon name="Check" className="size-3.5" />
              ) : null}
            </span>
            <span aria-hidden className={SHORTCUT_CLASS}>
              {index + kind.firstShortcut}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const STATUS_KIND: EditorKind<TaskStatus> = {
  values: TASK_STATUSES,
  labels: STATUS_LABELS,
  icon: (status) => <StatusIcon status={status} />,
  heading: "Change status…",
  mobileTitle: "Change status",
  letter: "S",
  firstShortcut: 1,
  width: "min-w-56",
};

const PRIORITY_KIND: EditorKind<TaskPriority> = {
  values: PRIORITY_MENU_ORDER,
  labels: PRIORITY_LABELS,
  icon: (priority) => <PriorityIcon priority={priority} />,
  heading: "Set priority to…",
  mobileTitle: "Set priority",
  letter: "P",
  firstShortcut: 0,
  width: "min-w-52",
};

export function StatusEditor(props: EditorProps<TaskStatus>) {
  return <PropertyEditor {...props} kind={STATUS_KIND} />;
}

export function PriorityEditor(props: EditorProps<TaskPriority>) {
  return <PropertyEditor {...props} kind={PRIORITY_KIND} />;
}
