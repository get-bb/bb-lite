import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  COARSE_POINTER_ROW_HEIGHT_CLASS,
  COARSE_POINTER_CHILD_ICON_BUTTON_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";

export const SIDEBAR_STATUS_ICON_CLASS = "size-4";

export const SIDEBAR_WORKING_STATUS_COLOR_CLASS = "text-muted-foreground/50";

export const SIDEBAR_SUCCESS_STATUS_DOT_CLASS =
  "size-[5px] rounded-full bg-muted-foreground/60";

export const SIDEBAR_STANDARD_ROW_PADDING_CLASS = "pl-2";

export const SIDEBAR_CONTROL_STATE_CLASS =
  "text-subtle-foreground hover:text-muted-foreground data-[state=open]:text-muted-foreground hover:bg-state-hover active:bg-state-active data-[state=open]:bg-state-active data-[state=open]:hover:bg-state-active";

export const SIDEBAR_FOOTER_ACTION_CLASS = cn(
  COARSE_POINTER_ROW_HEIGHT_CLASS,
  COARSE_POINTER_CHILD_ICON_BUTTON_CLASS,
  "text-muted-foreground hover:text-sidebar-foreground [&>[data-icon-root]]:opacity-80",
);

export const PROJECT_LIST_ACTION_BUTTON_CLASS = cn(
  "flex w-full items-center gap-2 rounded-md pr-0 text-sm transition-colors",
  LIST_HOVER_TRANSITION,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
  "cursor-pointer text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  COARSE_POINTER_ROW_HEIGHT_CLASS,
  "min-w-0 cursor-pointer justify-start overflow-hidden font-normal ring-sidebar-ring focus-visible:ring-2 disabled:cursor-default disabled:opacity-70",
);
