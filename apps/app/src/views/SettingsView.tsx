import { MachineEnvironmentSettings } from "@/components/settings/MachineEnvironmentSettings";
import { MachineAccessSettings } from "@/components/settings/MachineAccessSettings";
import { useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import "@bb/shared-ui/icon-extended";
import {
  builtInThemes,
  defaultAppSettings,
  defaultAppTheme,
  managedBranchPrefixSchema,
  type AppTheme,
  type FaviconColorPreference,
  type PluginThemeMeta,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Switch } from "@bb/shared-ui/switch";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import {
  setPreferredTheme,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/useTheme";
import { useAppThemePreview } from "@/hooks/useAppThemePreview";
import { ProvidersSettingsSection } from "@/components/settings/ProvidersSettingsSection";
import { SidebarThreadListSetting } from "@/components/settings/SidebarThreadListSetting";
import { SidebarNavigationSetting } from "@/components/settings/SidebarNavigationSetting";
import { SidebarHeaderSetting } from "@/components/settings/SidebarHeaderSetting";
import { SplitDimmingSetting } from "@/components/settings/SplitDimmingSetting";
import { useSettingsNavState } from "@/components/settings/settings-nav";
import { InstalledPluginsSettingsSection } from "@/components/settings/InstalledPluginsSettingsSection";
import { PluginSettingsPage } from "@/components/plugin/PluginSettings";
import { KeyboardSettingsSection } from "@/components/settings/KeyboardSettingsSection";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { ProjectsSettingsSection } from "@/components/settings/ProjectsSettingsSection";
import { ArchivedThreadsSettingsSection } from "@/components/settings/ArchivedThreadsSettingsSection";
import {
  useUpdateGeneralSettings,
  useUpdateAppearance,
} from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  FAVICON_COLOR_VALUES,
  getFaviconGlyphHref,
} from "@/lib/favicon-color-preference";
import { useRewriteLocalhostLinksPreference } from "@/lib/localhost-link-rewrite-preference";
import { localhostLinkRewriteDescription } from "@/lib/localhost-link-rewrite-description";
import { useRichTextEditingPreference } from "@/lib/rich-text-editing-preference";
import {
  SETTINGS_ROUTE_PATH,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import { cn } from "@bb/shared-ui/lib/utils";

interface ThemePreferenceOption {
  label: string;
  value: ThemePreference;
}

interface FaviconColorOption {
  label: string;
  value: FaviconColorPreference;
}

interface FaviconColorSettingsControlProps {
  disabled: boolean;
  faviconColor: FaviconColorPreference;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
}

interface AppearanceSettingsSectionProps {
  appearance: AppTheme;
  appearanceDisabled: boolean;
  customThemes: readonly string[];
  pluginThemes: readonly PluginThemeMeta[];
  faviconColor: FaviconColorPreference;
  onAppearanceThemeChange: (themeId: string) => void;
  onAppearanceThemePrefetch: (themeIds: readonly string[]) => void;
  onAppearanceThemePreview: (themeId: string | null) => void;
  onCreatePalette: () => void;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
  onThemePreferenceChange: (themePreference: ThemePreference) => void;
  themePreference: ThemePreference;
}

interface GeneralSettingsSectionProps {
  confirmThreadArchive: boolean;
  onConfirmThreadArchiveChange: (enabled: boolean) => void;
  generalSettingsDisabled: boolean;
  managedBranchPrefix: string;
  navigateToThreadAfterCreate: boolean;
  onManagedBranchPrefixChange: (prefix: string) => Promise<void> | void;
  onNavigateToThreadAfterCreateChange: (enabled: boolean) => void;
  onRewriteLocalhostLinksChange: (enabled: boolean) => void;
  onRichTextEditingChange: (enabled: boolean) => void;
  onSteerActiveThreadOnEnterChange: (enabled: boolean) => void;
  rewriteLocalhostLinks: boolean;
  richTextEditing: boolean;
  steerActiveThreadOnEnter: boolean;
}

interface PrivacySettingsSectionProps {
  onStreamerModeChange: (enabled: boolean) => void;
  streamerMode: boolean;
  disabled: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

function appPaletteLabel(
  appearance: AppTheme,
  pluginThemes: readonly PluginThemeMeta[],
): string {
  const meta = builtInThemes.find((entry) => entry.id === appearance.themeId);
  return (
    meta?.name ??
    pluginThemes.find((entry) => entry.id === appearance.themeId)?.name ??
    appearance.themeId
  );
}

const THEME_PREFERENCE_OPTIONS: ReadonlyArray<ThemePreferenceOption> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

const FAVICON_COLOR_OPTIONS: ReadonlyArray<FaviconColorOption> = [
  { label: "Default", value: "default" },
  { label: "Red", value: "red" },
  { label: "Orange", value: "orange" },
  { label: "Yellow", value: "yellow" },
  { label: "Green", value: "green" },
  { label: "Teal", value: "teal" },
  { label: "Blue", value: "blue" },
  { label: "Purple", value: "purple" },
  { label: "Pink", value: "pink" },
];

const FAVICON_COLOR_LABELS: Record<FaviconColorPreference, string> = {
  blue: "Blue",
  default: "Default",
  green: "Green",
  orange: "Orange",
  pink: "Pink",
  purple: "Purple",
  red: "Red",
  teal: "Teal",
  yellow: "Yellow",
};

const SETTINGS_DROPDOWN_TRIGGER_CLASS =
  "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs sm:w-36";
const SETTINGS_DROPDOWN_CONTENT_CLASS =
  "min-w-[var(--radix-dropdown-menu-trigger-width)]";

const CREATE_CUSTOM_PALETTE_PROMPT =
  "Create a custom bb palette. First run `bb theme dir` to find the custom theme directory. Ask me for the palette name and visual direction, then create `<theme-dir>/<name>/theme.css` with light and dark theme variables compatible with bb's theme tokens.";
const PALETTE_SETTING_DESCRIPTION =
  "Palettes change bb's colors, including syntax colors in diffs and file previews. Choose a built-in palette or create one from a prompt.";

interface PaletteMenuItemProps {
  active: boolean;
  children: ReactNode;
  onPreview: (themeId: string | null) => void;
  onSelect: (themeId: string) => void;
  themeId: string;
}

function PaletteMenuItem({
  active,
  children,
  onPreview,
  onSelect,
  themeId,
}: PaletteMenuItemProps) {
  return (
    <DropdownMenuItem
      onFocus={() => onPreview(themeId)}
      onBlur={() => onPreview(null)}
      onSelect={() => onSelect(themeId)}
    >
      {children}
      <Icon
        name="Check"
        className={cn(
          "ml-auto",
          !active && "opacity-0",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
      />
    </DropdownMenuItem>
  );
}

function FaviconColorPreview({ value }: { value: FaviconColorPreference }) {
  return (
    <span
      aria-hidden
      className={cn("size-4 shrink-0", value === "default" && "bg-foreground")}
      style={{
        mask: `url("${getFaviconGlyphHref()}") center / contain no-repeat`,
        ...(value === "default"
          ? undefined
          : { backgroundColor: FAVICON_COLOR_VALUES[value] }),
      }}
    />
  );
}

function FaviconColorSettingsControl({
  disabled,
  faviconColor,
  onFaviconColorChange,
}: FaviconColorSettingsControlProps) {
  return (
    <SettingsWithControl
      label="Favicon color"
      description="Tint browser tabs to tell instances apart."
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label="Favicon color"
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FaviconColorPreview value={faviconColor} />
              <span className="min-w-0 truncate">
                {FAVICON_COLOR_LABELS[faviconColor]}
              </span>
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {FAVICON_COLOR_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onFaviconColorChange(option.value)}
            >
              <FaviconColorPreview value={option.value} />
              {option.label}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  faviconColor !== option.value && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

const REWRITE_LOCALHOST_LINKS_SETTING_LABEL = "Rewrite localhost links";
const NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL =
  "Navigate to threads on creation";
const RICH_TEXT_EDITING_SETTING_LABEL = "Markdown formatting in prompt box";
const DIAGNOSTIC_EVENTS_SETTING_LABEL = "Show diagnostic events";
const FOLLOW_UP_BEHAVIOR_SETTING_LABEL = "Default thread followup behavior";
const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  {
    steerOnEnter: false,
    label: "Queue",
    description:
      "Enter adds a follow-up. It runs when the agent stops. Command+Enter (Ctrl+Enter on Windows and Linux) steers the run.",
  },
  {
    steerOnEnter: true,
    label: "Steer",
    description:
      "Enter steers the run now. Command+Enter (Ctrl+Enter on Windows and Linux) adds a follow-up for later.",
  },
] as const;
const STREAMER_MODE_SETTING_LABEL = "Streamer mode";
const MANAGED_BRANCH_PREFIX_SETTING_LABEL = "New branch prefix";
const MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG = "fix-login-flow-thr_ab12cd34ef";

interface ManagedBranchPrefixSettingProps {
  disabled: boolean;
  onChange: (prefix: string) => Promise<void> | void;
  value: string;
}

function ManagedBranchPrefixSetting({
  disabled,
  onChange,
  value,
}: ManagedBranchPrefixSettingProps) {
  const [draft, setDraft] = useState(value);
  const [committedValue, setCommittedValue] = useState(value);
  if (value !== committedValue) {
    setCommittedValue(value);
    setDraft(value);
  }

  const valid = managedBranchPrefixSchema.safeParse(draft).success;
  const commit = () => {
    if (!valid) {
      setDraft(value);
      return;
    }
    if (draft !== value) {
      void Promise.resolve(onChange(draft)).catch(() => setDraft(value));
    }
  };

  return (
    <SettingsWithControl
      label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
      description={
        valid ? (
          `bb puts this in front of every branch it creates for a worktree, such as ${draft}${MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG}. Leave it empty for no prefix.`
        ) : (
          <span className="text-destructive" role="alert">
            This prefix cannot start a valid git branch name.
          </span>
        )
      }
      controlPlacement="below"
    >
      <Input
        value={draft}
        aria-label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
        aria-invalid={!valid}
        disabled={disabled}
        placeholder="No prefix"
        className={cn(
          "h-8 font-mono text-xs",
          !valid && "border-destructive focus-visible:ring-destructive",
        )}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
          }
        }}
      />
    </SettingsWithControl>
  );
}

export function AppearanceSettingsSection({
  appearance,
  appearanceDisabled,
  customThemes,
  pluginThemes,
  faviconColor,
  onAppearanceThemeChange,
  onAppearanceThemePrefetch,
  onAppearanceThemePreview,
  onFaviconColorChange,
  onCreatePalette,
  onThemePreferenceChange,
  themePreference,
}: AppearanceSettingsSectionProps) {
  const paletteSelectedRef = useRef(false);
  const previewPalette = (themeId: string | null) => {
    if (themeId === null && paletteSelectedRef.current) return;
    onAppearanceThemePreview(themeId);
  };
  const selectPalette = (themeId: string) => {
    paletteSelectedRef.current = true;
    onAppearanceThemeChange(themeId);
  };
  return (
    <div className="space-y-6">
      <SettingsSection title="Appearance">
        <div className="space-y-5">
          <SettingsWithControl label="Theme">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  aria-label="Theme"
                >
                  {THEME_PREFERENCE_LABELS[themePreference]}
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
              >
                {THEME_PREFERENCE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => onThemePreferenceChange(option.value)}
                  >
                    {option.label}
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        themePreference !== option.value && "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>

          <SettingsWithControl
            label="Palette"
            description={PALETTE_SETTING_DESCRIPTION}
          >
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) {
                  paletteSelectedRef.current = false;
                  onAppearanceThemePrefetch([
                    ...builtInThemes.map((entry) => entry.id),
                    ...customThemes,
                    ...pluginThemes.map((theme) => theme.id),
                  ]);
                  return;
                }
                previewPalette(null);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  aria-label="Palette"
                  disabled={appearanceDisabled}
                >
                  <span className="min-w-0 truncate">
                    {appPaletteLabel(appearance, pluginThemes)}
                  </span>
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
              >
                {builtInThemes.map((entry) => (
                  <PaletteMenuItem
                    key={entry.id}
                    themeId={entry.id}
                    active={appearance.themeId === entry.id}
                    onPreview={previewPalette}
                    onSelect={selectPalette}
                  >
                    {entry.name}
                  </PaletteMenuItem>
                ))}
                {customThemes.map((name) => (
                  <PaletteMenuItem
                    key={`custom:${name}`}
                    themeId={name}
                    active={appearance.themeId === name}
                    onPreview={previewPalette}
                    onSelect={selectPalette}
                  >
                    {name}
                  </PaletteMenuItem>
                ))}
                {pluginThemes.map((theme) => (
                  <PaletteMenuItem
                    key={theme.id}
                    themeId={theme.id}
                    active={appearance.themeId === theme.id}
                    onPreview={previewPalette}
                    onSelect={selectPalette}
                  >
                    {theme.name}
                    <span className="text-muted-foreground">
                      ({theme.pluginId})
                    </span>
                  </PaletteMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onCreatePalette}>
                  <Icon
                    name="Plus"
                    className={COARSE_POINTER_ICON_SIZE_CLASS}
                  />
                  Create
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>

          <FaviconColorSettingsControl
            disabled={appearanceDisabled}
            faviconColor={faviconColor}
            onFaviconColorChange={onFaviconColorChange}
          />
          <SplitDimmingSetting />
        </div>
      </SettingsSection>
      <SettingsSection title="Interface">
        <div className="space-y-5">
          <SidebarThreadListSetting />
          <SidebarNavigationSetting />
          <SidebarHeaderSetting />
        </div>
      </SettingsSection>
    </div>
  );
}

export function GeneralSettingsSection({
  confirmThreadArchive,
  onConfirmThreadArchiveChange,
  generalSettingsDisabled,
  managedBranchPrefix,
  navigateToThreadAfterCreate,
  onManagedBranchPrefixChange,
  onNavigateToThreadAfterCreateChange,
  onRewriteLocalhostLinksChange,
  onRichTextEditingChange,
  onSteerActiveThreadOnEnterChange,
  rewriteLocalhostLinks,
  richTextEditing,
  steerActiveThreadOnEnter,
}: GeneralSettingsSectionProps) {
  const localhostRewriteDescription = localhostLinkRewriteDescription(
    typeof window === "undefined" ? undefined : window.location.hostname,
  );
  return (
    <>
      <SettingsSection title="Threads & editing">
        <div className="space-y-5">
          <SettingsWithControl
            label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
          >
            <Switch
              checked={navigateToThreadAfterCreate}
              onCheckedChange={onNavigateToThreadAfterCreateChange}
              aria-label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
            />
          </SettingsWithControl>

          <SettingsWithControl label={RICH_TEXT_EDITING_SETTING_LABEL}>
            <Switch
              checked={richTextEditing}
              onCheckedChange={onRichTextEditingChange}
              aria-label={RICH_TEXT_EDITING_SETTING_LABEL}
            />
          </SettingsWithControl>

          <SettingsWithControl
            label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
            description="What Enter does in the prompt box while the thread runs."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  disabled={generalSettingsDisabled}
                  aria-label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
                >
                  {steerActiveThreadOnEnter ? "Steer" : "Queue"}
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={cn(SETTINGS_DROPDOWN_CONTENT_CLASS, "max-w-72")}
              >
                {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.label}
                    className="items-start"
                    onSelect={() =>
                      onSteerActiveThreadOnEnterChange(option.steerOnEnter)
                    }
                  >
                    <span className="min-w-0">
                      <span className="block">{option.label}</span>
                      <span className="block text-2xs leading-snug text-subtle-foreground">
                        {option.description}
                      </span>
                    </span>
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        steerActiveThreadOnEnter !== option.steerOnEnter &&
                          "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>

          <SettingsWithControl
            label="Thread archive confirmation"
            description="Ask before archiving a thread with unarchived children."
          >
            <Switch
              checked={confirmThreadArchive}
              disabled={generalSettingsDisabled}
              onCheckedChange={onConfirmThreadArchiveChange}
              aria-label="Thread archive confirmation"
            />
          </SettingsWithControl>
        </div>
      </SettingsSection>
      {localhostRewriteDescription !== null ? (
        <SettingsSection title="Links">
          <div className="space-y-5">
            <SettingsWithControl
              label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
              description={
                <span className="break-words [overflow-wrap:anywhere]">
                  {localhostRewriteDescription}
                </span>
              }
            >
              <Switch
                checked={rewriteLocalhostLinks}
                onCheckedChange={onRewriteLocalhostLinksChange}
                aria-label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
              />
            </SettingsWithControl>
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Git">
        <div className="space-y-5">
          <ManagedBranchPrefixSetting
            value={managedBranchPrefix}
            disabled={generalSettingsDisabled}
            onChange={onManagedBranchPrefixChange}
          />
        </div>
      </SettingsSection>
    </>
  );
}

export function PrivacySettingsSection({
  disabled,
  enabled,
  onEnabledChange,
  streamerMode,
  onStreamerModeChange,
}: PrivacySettingsSectionProps) {
  return (
    <SettingsSection title="Privacy & diagnostics">
      <div className="space-y-5">
        <SettingsWithControl
          label={STREAMER_MODE_SETTING_LABEL}
          description="Hide the custom models from config.json in every model picker, so a screen share does not show them."
        >
          <Switch
            checked={streamerMode}
            disabled={disabled}
            onCheckedChange={onStreamerModeChange}
            aria-label={STREAMER_MODE_SETTING_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={DIAGNOSTIC_EVENTS_SETTING_LABEL}
          description="Show provider environment resolution and unhandled provider events for troubleshooting."
        >
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
            aria-label={DIAGNOSTIC_EVENTS_SETTING_LABEL}
          />
        </SettingsWithControl>
      </div>
    </SettingsSection>
  );
}

export function SettingsView() {
  const navigate = useNavigate();
  const themePreference = useThemePreference();
  const systemConfigQuery = useSystemConfig();
  const [rewriteLocalhostLinks, setRewriteLocalhostLinks] =
    useRewriteLocalhostLinksPreference();
  const [navigateToThreadAfterCreate, setNavigateToThreadAfterCreate] =
    useNavigateToThreadAfterCreatePreference();
  const [richTextEditing, setRichTextEditing] = useRichTextEditingPreference();
  const generalSettings =
    systemConfigQuery.data?.generalSettings ?? defaultAppSettings;
  const updateGeneralSettingsMutation = useUpdateGeneralSettings();
  const appearance = systemConfigQuery.data?.appearance ?? defaultAppTheme;
  const updateAppearanceMutation = useUpdateAppearance();
  const appThemePreview = useAppThemePreview();
  const { activePluginId, activeSection, hasUnknownSection } =
    useSettingsNavState();
  if (hasUnknownSection) {
    return <Navigate to={SETTINGS_ROUTE_PATH} replace />;
  }

  let content: ReactNode = null;
  if (activePluginId !== null) {
    content = <PluginSettingsPage pluginId={activePluginId} />;
  } else if (activeSection === "plugins") {
    content = <InstalledPluginsSettingsSection />;
  } else if (activeSection === "providers") {
    content = (
      <ProvidersSettingsSection
        disabled={
          systemConfigQuery.data === undefined ||
          updateGeneralSettingsMutation.isPending
        }
        generalSettings={generalSettings}
        onGeneralSettingsChange={(next) =>
          updateGeneralSettingsMutation.mutateAsync(next)
        }
      />
    );
  } else if (activeSection === "appearance") {
    content = (
      <AppearanceSettingsSection
        appearance={appearance}
        appearanceDisabled={
          systemConfigQuery.data === undefined ||
          updateAppearanceMutation.isPending
        }
        customThemes={systemConfigQuery.data?.customThemes ?? []}
        pluginThemes={systemConfigQuery.data?.pluginThemes ?? []}
        faviconColor={appearance.faviconColor}
        themePreference={themePreference}
        onAppearanceThemeChange={(themeId) =>
          updateAppearanceMutation.mutate(
            {
              themeId,
              faviconColor: appearance.faviconColor,
            },
            { onError: () => appThemePreview.previewTheme(null) },
          )
        }
        onAppearanceThemePrefetch={appThemePreview.prefetchThemes}
        onAppearanceThemePreview={appThemePreview.previewTheme}
        onCreatePalette={() =>
          navigate(getRootComposeRoutePath(), {
            state: {
              focusPrompt: true,
              initialPrompt: CREATE_CUSTOM_PALETTE_PROMPT,
            },
          })
        }
        onFaviconColorChange={(faviconColor) =>
          updateAppearanceMutation.mutate({
            themeId: appearance.themeId,
            faviconColor,
          })
        }
        onThemePreferenceChange={setPreferredTheme}
      />
    );
  } else if (activeSection === "keyboard") {
    content = <KeyboardSettingsSection />;
  } else if (activeSection === "projects") {
    content = <ProjectsSettingsSection />;
  } else if (activeSection === "machines") {
    content = (
      <>
        <MachinesSettingsSection />
        <MachineAccessSettings />
      </>
    );
  } else if (activeSection === "environment-variables") {
    content = <MachineEnvironmentSettings />;
  } else if (activeSection === "archived") {
    content = <ArchivedThreadsSettingsSection />;
  } else {
    content = (
      <>
        <GeneralSettingsSection
          confirmThreadArchive={generalSettings.confirmThreadArchive}
          onConfirmThreadArchiveChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              confirmThreadArchive: enabled,
            })
          }
          generalSettingsDisabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          managedBranchPrefix={generalSettings.managedBranchPrefix}
          onManagedBranchPrefixChange={async (prefix) => {
            await updateGeneralSettingsMutation.mutateAsync({
              ...generalSettings,
              managedBranchPrefix: prefix,
            });
          }}
          navigateToThreadAfterCreate={navigateToThreadAfterCreate}
          rewriteLocalhostLinks={rewriteLocalhostLinks}
          richTextEditing={richTextEditing}
          steerActiveThreadOnEnter={generalSettings.steerActiveThreadOnEnter}
          onNavigateToThreadAfterCreateChange={setNavigateToThreadAfterCreate}
          onRewriteLocalhostLinksChange={setRewriteLocalhostLinks}
          onRichTextEditingChange={setRichTextEditing}
          onSteerActiveThreadOnEnterChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              steerActiveThreadOnEnter: enabled,
            })
          }
        />
        <PrivacySettingsSection
          streamerMode={generalSettings.streamerMode}
          onStreamerModeChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              streamerMode: enabled,
            })
          }
          enabled={generalSettings.showDiagnosticEvents}
          disabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          onEnabledChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              showDiagnosticEvents: enabled,
            })
          }
        />
      </>
    );
  }

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-10">{content}</div>
    </PageShell>
  );
}
