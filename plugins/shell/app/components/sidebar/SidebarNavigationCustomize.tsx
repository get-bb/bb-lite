import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { SidebarSortableList } from "@bb/shared-ui/sidebar-sortable-list";
import { Switch } from "@bb/shared-ui/switch";
import {
  NEW_THREAD_NAVIGATION_ITEM_ID,
  SidebarNavigationIcon,
  useSidebarNavigationModel,
} from "./SidebarNavigationModel";

export function SidebarNavigationCustomize({
  onClose,
}: {
  onClose: () => void;
}) {
  const model = useSidebarNavigationModel();
  if (model === null) return null;
  const items = model.state.items.filter(
    (item) => item.id !== NEW_THREAD_NAVIGATION_ITEM_ID,
  );
  const { arrangement } = model;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-1"
      data-testid="nav-rail-customize-list"
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-sm font-medium">Customize rail</span>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
      <ul
        aria-label="Rail items"
        className="flex min-h-0 flex-col gap-0.5 overflow-y-auto"
      >
        <SidebarSortableList
          items={items}
          onReorder={(itemId, overId) => arrangement.moveTo(itemId, overId)}
          renderItem={(item, { setNodeRef, style, dragBindings }) => {
            const index = items.indexOf(item);
            return (
              <li
                ref={setNodeRef}
                style={style}
                data-nav-rail-customize-item={item.id}
                className="flex h-8 items-center gap-1 rounded-md bg-popover px-1"
              >
                <button
                  type="button"
                  ref={dragBindings.setActivatorNodeRef}
                  {...dragBindings.attributes}
                  {...dragBindings.listeners}
                  aria-label={`Reorder ${item.label}`}
                  className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-subtle-foreground/60 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
                >
                  <Icon name="DragDropVertical" aria-hidden="true" />
                </button>
                <SidebarNavigationIcon icon={item.icon} className="size-4" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.label}
                </span>
                <Button
                  type="button"
                  size="icon"
                  className="size-6"
                  variant="ghost"
                  aria-label={`Move ${item.label} up`}
                  disabled={index === 0}
                  onClick={() => arrangement.move(item.id, -1)}
                >
                  <Icon name="ArrowUp" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  className="size-6"
                  variant="ghost"
                  aria-label={`Move ${item.label} down`}
                  disabled={index === items.length - 1}
                  onClick={() => arrangement.move(item.id, 1)}
                >
                  <Icon name="ArrowDown" aria-hidden="true" />
                </Button>
                <Switch
                  aria-label={`Show ${item.label} in rail`}
                  checked={item.isVisible}
                  disabled={item.isDisabled}
                  onCheckedChange={(isVisible) =>
                    arrangement.setVisible(item.id, isVisible)
                  }
                />
              </li>
            );
          }}
        />
      </ul>
    </div>
  );
}
