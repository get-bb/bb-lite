import type { AppTheme } from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type { Http } from "../http.js";

export interface ThemeArea {
  set(selection: AppTheme): Promise<AppTheme>;
  set(themeId: string): Promise<AppTheme>;
}

export function createThemeArea(http: Http): ThemeArea {
  const routes = publicApiRoutes.system;
  return {
    async set(input: AppTheme | string) {
      if (typeof input !== "string") {
        return http.json(routes.appearance, { json: input });
      }
      const { appearance } = await http.json(routes.config, {});
      const { faviconColor } = appearance;
      const json = { themeId: input, faviconColor };
      return http.json(routes.appearance, { json });
    },
  };
}
