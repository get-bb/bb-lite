import { useEffect, useRef } from "react";
import { matchPath, useLocation } from "react-router-dom";
import {
  getRootComposeRoutePath,
  SETTINGS_ROUTE_PATH,
} from "@/lib/route-paths";

export function useAppSettingsRouteMemory() {
  const { pathname, search, hash } = useLocation();
  const current = `${pathname}${search}${hash}`;
  const isSettings = matchPath(`${SETTINGS_ROUTE_PATH}/*`, pathname) !== null;
  const lastAppRef = useRef(isSettings ? getRootComposeRoutePath() : current);
  const lastSettingsRef = useRef(isSettings ? current : SETTINGS_ROUTE_PATH);
  useEffect(() => {
    (isSettings ? lastSettingsRef : lastAppRef).current = current;
  }, [current, isSettings]);
  return {
    appRoutePath: isSettings ? lastAppRef.current : current,
    settingsRoutePath: isSettings ? current : lastSettingsRef.current,
  };
}
