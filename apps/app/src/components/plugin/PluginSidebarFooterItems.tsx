import { Link } from "react-router-dom";
import { Icon } from "@bb/shared-ui/icon";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.js";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "@bb/shared-ui/sidebar-row-classes";

const FOOTER_ITEMS = {
  settings: { label: "Settings", icon: "Settings" },
  "report-bug": { label: "Report a bug", icon: "Bug" },
} as const;

export interface BuiltinFooterAction {
  id: keyof typeof FOOTER_ITEMS;
  onActivate(): void;
  href?: string;
  ariaLabel?: string;
  ariaKeyShortcuts?: string;
}

export function PluginSidebarFooterItems({
  builtInActions = [],
}: {
  builtInActions?: readonly BuiltinFooterAction[];
}) {
  return (
    <SidebarMenuItem className="min-w-0 flex-1">
      <SidebarMenu className="flex-row items-center gap-1">
        {builtInActions.map((action) => {
          const item = FOOTER_ITEMS[action.id];
          const label = action.ariaLabel ?? item.label;
          const content = (
            <>
              <Icon
                name={item.icon}
                className="size-4 shrink-0"
                aria-hidden="true"
              />
              <span className="sr-only">{item.label}</span>
            </>
          );
          return (
            <SidebarMenuItem
              key={action.id}
              className="min-w-0 shrink-0"
              data-footer-item={`builtin:${action.id}`}
            >
              <SidebarMenuButton
                asChild={action.href !== undefined}
                id={`sidebar-footer-${action.id}`}
                aria-label={label}
                aria-keyshortcuts={action.ariaKeyShortcuts}
                tooltip={{ children: label, hidden: false, side: "top" }}
                className={SIDEBAR_FOOTER_ACTION_CLASS}
                onClick={
                  action.href === undefined ? action.onActivate : undefined
                }
              >
                {action.href === undefined ? (
                  content
                ) : (
                  <Link to={action.href}>{content}</Link>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarMenuItem>
  );
}
