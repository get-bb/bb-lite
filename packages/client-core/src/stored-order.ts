export function arrayMove<T>(
  array: readonly T[],
  from: number,
  to: number,
): T[] {
  const result = [...array];
  const [moved] = result.splice(from, 1);
  if (moved !== undefined) {
    result.splice(to < 0 ? result.length + to : to, 0, moved);
  }
  return result;
}

type ReorderStoredOrderArgs<TId extends string> = {
  order: readonly TId[];
  visibleIds: readonly TId[];
} & ({ activeId: string; overId: string } | { nextVisibleIds: readonly TId[] });

export function reorderStoredOrder<TId extends string>(
  args: ReorderStoredOrderArgs<TId>,
): TId[] | null {
  const { order, visibleIds } = args;
  const visibleSet = new Set(visibleIds);
  let nextVisible: readonly TId[];
  if ("nextVisibleIds" in args) {
    nextVisible = args.nextVisibleIds;
    if (
      nextVisible.length !== visibleIds.length ||
      new Set(nextVisible).size !== visibleSet.size ||
      nextVisible.some((id) => !visibleSet.has(id)) ||
      nextVisible.every((id, index) => id === visibleIds[index])
    ) {
      return null;
    }
  } else {
    const from = visibleIds.findIndex((id) => id === args.activeId);
    const to = visibleIds.findIndex((id) => id === args.overId);
    if (from === -1 || to === -1 || from === to) return null;
    nextVisible = arrayMove(visibleIds, from, to);
  }
  let cursor = 0;
  return order.map((id) => (visibleSet.has(id) ? nextVisible[cursor++] : id));
}
