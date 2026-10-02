import {
  applyAppKeybindingOverrides,
  appSettingsSchema,
  customThemeNameSchema,
  isBuiltInThemeId,
} from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import { dataPaths } from "../../config.js";
import type { ServerContext } from "../../context.js";
import {
  appearanceSetting,
  getAppSettings,
  keybindingOverridesSetting,
  readSetting,
  setAppSettings,
  writeSetting,
} from "../../db/settings.js";
import { publicServerUrl } from "../../runners/hosts.js";
import { DEFAULT_APP_KEYBINDINGS } from "../../settings/keybindings.js";
import {
  customThemeCssPath,
  listCustomThemes,
  readCustomThemeCss,
  resolveTheme,
} from "../../settings/themes.js";
import { typedApi, type ApiApp } from "../api.js";
import {
  CUT_FEATURE_SYSTEM_CONFIG,
  DIRECT_SERVER_ACCESS_PROVIDER,
} from "../cut-feature-constants.js";
import { ApiError, invalidRequest } from "../errors.js";

function serverPlatform(): "darwin" | "linux" | "unknown" {
  const { platform } = process;
  return platform === "darwin" || platform === "linux" ? platform : "unknown";
}

export function registerSettingsRoutes(app: ApiApp, ctx: ServerContext): void {
  const { get, put } = typedApi(app);
  const routes = publicApiRoutes.system;
  const themesDir = dataPaths(ctx.config.dataDir).themes;
  const appearance = () => readSetting(ctx.db, appearanceSetting);
  const activeTheme = () => resolveTheme(themesDir, appearance());

  async function requireKnownTheme(themeId: string): Promise<void> {
    if (isBuiltInThemeId(themeId)) return;
    if (!customThemeNameSchema.safeParse(themeId).success) {
      throw invalidRequest(`Invalid theme id '${themeId}'.`);
    }
    if ((await readCustomThemeCss(themesDir, themeId)) === null) {
      const path = customThemeCssPath(themesDir, themeId);
      throw new ApiError(
        404,
        "theme_not_found",
        `Custom theme '${themeId}' not found. Create ${path} first.`,
      );
    }
  }

  get(routes.config, async (c) => {
    const generalSettings = getAppSettings(ctx.db);
    const keybindingOverrides = readSetting(ctx.db, keybindingOverridesSetting);
    const publicUrl = publicServerUrl(ctx);
    return c.json({
      ...CUT_FEATURE_SYSTEM_CONFIG,
      serverAccess: {
        providers: [DIRECT_SERVER_ACCESS_PROVIDER],
        defaultProviderId: DIRECT_SERVER_ACCESS_PROVIDER.id,
        effectiveUrl: publicUrl,
        urlSource: publicUrl === null ? null : "setting",
      },
      generalSettings,
      keybindings: applyAppKeybindingOverrides(
        DEFAULT_APP_KEYBINDINGS,
        keybindingOverrides,
      ),
      defaultKeybindings: DEFAULT_APP_KEYBINDINGS,
      keybindingOverrides,
      appearance: await activeTheme(),
      customThemes: await listCustomThemes(themesDir),
      serverUrl: publicUrl ?? new URL(c.req.url).origin,
      primaryHostId: ctx.config.hostId,
      primaryHostPlatform: serverPlatform(),
      dataDir: ctx.config.dataDir,
    });
  });

  get(routes.attention, (c) => c.json({ hasAttention: false }));

  put(routes.generalSettings, (c, payload) => {
    const { showUnhandledProviderEvents, ...settings } = payload;
    const current = getAppSettings(ctx.db);
    const updated = appSettingsSchema.parse({
      ...current,
      ...settings,
      showDiagnosticEvents:
        "showDiagnosticEvents" in settings
          ? settings.showDiagnosticEvents
          : showUnhandledProviderEvents,
    });
    setAppSettings(ctx.db, updated);
    ctx.hub.system(["config-changed"]);
    return c.json(updated);
  });

  put(routes.keyboardSettings, (c, overrides) => {
    writeSetting(ctx.db, keybindingOverridesSetting, overrides);
    ctx.hub.system(["config-changed"]);
    return c.json(overrides);
  });

  put(routes.appearance, async (c, selection) => {
    await requireKnownTheme(selection.themeId);
    writeSetting(ctx.db, appearanceSetting, selection);
    ctx.hub.system(["config-changed"]);
    return c.json(await activeTheme());
  });

  get(routes.themes, async (c) =>
    c.json({
      dir: themesDir,
      custom: await listCustomThemes(themesDir),
      plugins: CUT_FEATURE_SYSTEM_CONFIG.pluginThemes,
      active: await activeTheme(),
    }),
  );

  get(routes.resolveTheme, async (c) => {
    const themeId = c.req.param("id");
    await requireKnownTheme(themeId);
    const { faviconColor } = appearance();
    return c.json(await resolveTheme(themesDir, { themeId, faviconColor }));
  });
}
