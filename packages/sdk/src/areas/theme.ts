import type { AppTheme, AppThemeSelection } from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type { Http } from "../http.js";

export interface ThemeArea {
  resolve(args: { themeId: string; signal?: AbortSignal }): Promise<AppTheme>;
  set(selection: AppThemeSelection): Promise<AppTheme>;
  set(themeId: string): Promise<AppTheme>;
}

export function createThemeArea(http: Http): ThemeArea {
  const routes = publicApiRoutes.system;
  return {
    resolve: ({ themeId, signal }) =>
      http.json(routes.resolveTheme, { param: { id: themeId } }, signal),
    async set(input: AppThemeSelection | string) {
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
