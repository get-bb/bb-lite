export interface RailItemPreferences {
  order: readonly string[];
  hidden: readonly string[];
}

export interface StoredRailItems {
  order: string[];
  hidden: string[];
}

export function arrangeRailItems<Item extends { id: string }>(
  items: readonly Item[],
  preferences: RailItemPreferences,
  pinnedIds: readonly string[],
): { ordered: Item[]; visibleIds: string[] } {
  const rank = new Map(preferences.order.map((id, index) => [id, index]));
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aPinned = pinnedIds.includes(a.item.id);
      const bPinned = pinnedIds.includes(b.item.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      const aRank = rank.get(a.item.id);
      const bRank = rank.get(b.item.id);
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
  const hidden = new Set(preferences.hidden);
  const visibleIds = ordered
    .map((item) => item.id)
    .filter((id) => pinnedIds.includes(id) || !hidden.has(id));
  return { ordered, visibleIds };
}

export function setRailItemVisible(
  preferences: RailItemPreferences,
  id: string,
  isVisible: boolean,
): StoredRailItems {
  const hidden = preferences.hidden.filter((hiddenId) => hiddenId !== id);
  return {
    order: [...preferences.order],
    hidden: isVisible ? hidden : [...hidden, id],
  };
}

export function moveRailItem(
  preferences: RailItemPreferences,
  orderedIds: readonly string[],
  id: string,
  offset: number,
): StoredRailItems {
  const from = orderedIds.indexOf(id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= orderedIds.length) {
    return { order: [...preferences.order], hidden: [...preferences.hidden] };
  }
  const order = [...orderedIds];
  order.splice(from, 1);
  order.splice(to, 0, id);
  return { order, hidden: [...preferences.hidden] };
}
