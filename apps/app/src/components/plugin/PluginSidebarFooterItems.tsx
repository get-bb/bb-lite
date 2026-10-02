import { useRef } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@bb/shared-ui/icon";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.js";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  useSidebarFooterPreferences,
  useMeasureSidebarFooterCapacity,
  SIDEBAR_FOOTER_MORE_ID,
  type FooterItem,
  type BuiltinFooterId,
} from "@/components/sidebar/sidebarFooterPreferences";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "@bb/shared-ui/sidebar-row-classes";

export interface BuiltinFooterAction {
  id: BuiltinFooterId;
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
  const preferences = useSidebarFooterPreferences();
  const menuRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useMeasureSidebarFooterCapacity(menuRef, moreRef);
  const isAvailable = (item: FooterItem) =>
    builtInActions.some((action) => action.id === item.id);
  const items = preferences.items.filter(isAvailable);
  const visible = preferences.footer.filter(isAvailable);
  const hidden = items.filter((item) => !visible.includes(item));
  const footerHidden = preferences.items.every((item) =>
    preferences.hidden.includes(item.key),
  );

  function activate(item: FooterItem) {
    builtInActions.find((action) => action.id === item.id)?.onActivate();
  }
  return (
    <SidebarMenuItem className="min-w-0 flex-1">
      <SidebarMenu ref={menuRef} className="flex-row items-center gap-1">
        {visible.map((item) => {
          const builtin = builtInActions.find(
            (action) => action.id === item.id,
          );
          const label = builtin?.ariaLabel ?? item.label;
          return (
            <ContextMenu key={item.key}>
              <ContextMenuTrigger asChild>
                <SidebarMenuItem
                  className="min-w-0 shrink-0"
                  data-footer-item={item.key}
                >
                  <SidebarMenuButton
                    asChild={builtin?.href !== undefined}
                    id={`sidebar-footer-${item.id}`}
                    aria-label={label}
                    aria-keyshortcuts={builtin?.ariaKeyShortcuts}
                    tooltip={{ children: label, hidden: false, side: "top" }}
                    className={SIDEBAR_FOOTER_ACTION_CLASS}
                    onClick={
                      builtin?.href === undefined
                        ? () => activate(item)
                        : undefined
                    }
                  >
                    {builtin?.href !== undefined ? (
                      <Link to={builtin.href}>
                        <FooterItemIcon item={item} />
                        <span className="sr-only">{item.label}</span>
                      </Link>
                    ) : (
                      <>
                        <FooterItemIcon item={item} />
                        <span className="sr-only">{item.label}</span>
                      </>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => preferences.hideFromFooter(item.key)}
                >
                  <Icon name="EyeOff" />
                  Hide from footer
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        <SidebarMenuItem className="min-w-0 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                ref={moreRef}
                id={SIDEBAR_FOOTER_MORE_ID}
                aria-label="More footer actions"
                tooltip={{ children: "More", hidden: false, side: "top" }}
                className={SIDEBAR_FOOTER_ACTION_CLASS}
              >
                <Icon name="MoreHorizontal" />
                <span className="sr-only">More</span>
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              {hidden.map((item) => (
                <DropdownMenuItem
                  key={item.key}
                  onSelect={() => activate(item)}
                >
                  <FooterItemIcon item={item} />
                  {item.label}
                </DropdownMenuItem>
              ))}
              {hidden.length > 0 && <DropdownMenuSeparator />}
              {items.length > 0 && (
                <DropdownMenuItem
                  onSelect={() => preferences.setFooterShown(footerHidden)}
                >
                  <Icon name={footerHidden ? "Eye" : "EyeOff"} />
                  {footerHidden ? "Show footer" : "Hide footer"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarMenuItem>
  );
}

function FooterItemIcon({ item }: { item: FooterItem }) {
  return (
    <Icon name={item.icon} className="size-4 shrink-0" aria-hidden="true" />
  );
}
