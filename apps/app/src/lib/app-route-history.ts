import { useEffect, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import type { Location, NavigationType } from "react-router-dom";

interface RouteHistory {
  entries: { key: string; url: string }[];
  index: number;
}

let history: RouteHistory = { entries: [], index: 0 };
let lastRecordedLocation: Location | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function recordLocation(location: Location, type: NavigationType): void {
  if (lastRecordedLocation === location) return;
  lastRecordedLocation = location;
  const { pathname, search, hash, key } = location;
  const entry = { key, url: `${pathname}${search}${hash}` };
  const { entries, index } = history;
  const matchedIndex = entries.findIndex(
    (candidate) => candidate.key === key && candidate.url === entry.url,
  );
  if (entries.length > 0 && type === "PUSH") {
    history = {
      entries: [...entries.slice(0, index + 1), entry],
      index: index + 1,
    };
  } else if (entries.length > 0 && type === "REPLACE") {
    const replaced = entries.map((candidate, candidateIndex) =>
      candidateIndex === index ? entry : candidate,
    );
    history = { entries: replaced, index };
  } else if (entries.length > 0 && matchedIndex >= 0) {
    history = { entries, index: matchedIndex };
  } else {
    history = { entries: [entry], index: 0 };
  }
  for (const listener of listeners) listener();
}

function findTargetIndex(state: RouteHistory, step: -1 | 1): number | null {
  const currentUrl = state.entries[state.index]?.url;
  for (
    let candidate = state.index + step;
    currentUrl !== undefined && state.entries[candidate] !== undefined;
    candidate += step
  ) {
    if (state.entries[candidate]?.url !== currentUrl) return candidate;
  }
  return null;
}

export function useRouteStateHistoryNavigation() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  useEffect(() => {
    recordLocation(location, navigationType);
  }, [location, navigationType]);
  const state = useSyncExternalStore(subscribe, () => history);
  const go = (step: -1 | 1) => () => {
    const target = findTargetIndex(history, step);
    if (target !== null) void navigate(target - history.index);
  };
  return {
    canGoBack: findTargetIndex(state, -1) !== null,
    canGoForward: findTargetIndex(state, 1) !== null,
    goBack: go(-1),
    goForward: go(1),
  };
}
