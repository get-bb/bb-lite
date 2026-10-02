import { useRef, useState } from "react";
import { useAtom, type WritableAtom } from "jotai";
import { Navigate } from "react-router-dom";
import "@bb/shared-ui/icon-extended";
import {
  builtInThemes,
  defaultAppSettings,
  defaultAppTheme,
  faviconColorPreferenceSchema,
  managedBranchPrefixSchema,
  type AppSettings,
  type AppTheme,
  type FaviconColorPreference,
} from "@bb/domain";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  InstalledPluginsSettingsSection,
  PluginSettingsPage,
} from "@/components/plugin/PluginSettings";
import { ArchivedThreadsSettingsSection } from "@/components/settings/ArchivedThreadsSettingsSection";
import { KeyboardSettingsSection } from "@/components/settings/KeyboardSettingsSection";
import { MachineAccessSettings } from "@/components/settings/MachineAccessSettings";
import { MachineEnvironmentSettings } from "@/components/settings/MachineEnvironmentSettings";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { ProjectsSettingsSection } from "@/components/settings/ProjectsSettingsSection";
import { ProvidersSettingsSection } from "@/components/settings/ProvidersSettingsSection";
import {
  SettingsDropdown,
  SettingsSwitch,
} from "@/components/settings/SettingsDropdown";
import { useSettingsNavState } from "@/components/settings/settings-nav";
import { sidebarHeaderProviderAtom } from "@/components/sidebar/sidebarHeaderProvider";
import {
  BUNDLED_NAVIGATION_PROVIDER,
  sidebarNavigationProviderAtom,
} from "@/components/sidebar/sidebarNavigationProvider";
import {
  BUNDLED_THREAD_LIST_PROVIDER,
  threadListProviderAtom,
} from "@/components/sidebar/threadListProvider";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import {
  useUpdateAppearance,
  useUpdateGeneralSettings,
} from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useAppThemePreview } from "@/hooks/useAppThemePreview";
import {
  setPreferredTheme,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/useTheme";
import {
  FAVICON_COLOR_VALUES,
  getFaviconGlyphHref,
} from "@/lib/favicon-color-preference";
import { localhostLinkRewriteDescription } from "@/lib/localhost-link-rewrite-description";
import { useRewriteLocalhostLinksPreference } from "@/lib/localhost-link-rewrite-preference";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import { SETTINGS_ROUTE_PATH } from "@/lib/route-paths";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  AUTOMATIC_PROVIDER,
  NO_PROVIDER,
  findAutomaticProvider,
  providerKey,
  usePluginSlots,
} from "@/plugins/registry";

const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
];
const FOLLOW_UP_OPTIONS = [
  {
    value: false,
    label: "Queue",
    description:
      "Enter adds a follow-up. It runs when the agent stops. Command+Enter (Ctrl+Enter on Windows and Linux) steers the run.",
  },
  {
    value: true,
    label: "Steer",
    description:
      "Enter steers the run now. Command+Enter (Ctrl+Enter on Windows and Linux) adds a follow-up for later.",
  },
];

type UpdateSettings = (
  patch: Partial<AppSettings>,
  options?: { onError?: () => void },
) => void;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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

function ManagedBranchPrefixSetting({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (prefix: string, onError: () => void) => void;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const [committedValue, setCommittedValue] = useState(value);
  if (value !== committedValue) {
    setCommittedValue(value);
    setDraft(value);
  }
  const valid = managedBranchPrefixSchema.safeParse(draft).success;
  const commit = () => {
    if (!valid) setDraft(value);
    else if (draft !== value) onChange(draft, () => setDraft(value));
  };
  return (
    <SettingsWithControl
      label="New branch prefix"
      description={
        valid ? (
          `bb puts this in front of every branch it creates for a worktree, such as ${draft}fix-login-flow-thr_ab12cd34ef. Leave it empty for no prefix.`
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
        aria-label="New branch prefix"
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

interface ProviderChoiceProps {
  label: string;
  description: string;
  atom: WritableAtom<string, [string], void>;
  slots: readonly { pluginId: string; id: string; title: string }[];
  bundled?: string;
  builtIn?: boolean;
}

function ProviderChoice({
  label,
  description,
  atom,
  slots,
  bundled,
  builtIn,
}: ProviderChoiceProps) {
  const [preference, setPreference] = useAtom(atom);
  const options = [
    ...slots.map((slot) => ({
      value: providerKey(slot),
      content: slot.title,
    })),
    ...(builtIn ? [{ value: NO_PROVIDER, content: "bb (built-in)" }] : []),
  ];
  const automatic = findAutomaticProvider(slots, bundled);
  const value =
    preference === AUTOMATIC_PROVIDER && automatic !== undefined
      ? providerKey(automatic)
      : preference;
  return (
    <SettingsDropdown
      label={label}
      description={description}
      trigger={
        <span className="min-w-0 truncate">
          {options.find((option) => option.value === value)?.content ??
            "Unavailable plugin"}
        </span>
      }
      value={value}
      options={options}
      onSelect={setPreference}
    />
  );
}

function AppearanceSettingsSection({
  appearance,
  disabled,
}: {
  appearance: AppTheme;
  disabled: boolean;
}) {
  const themePreference = useThemePreference();
  const updateAppearance = useUpdateAppearance();
  const preview = useAppThemePreview();
  const [dimsInactiveSplits, setDimsInactiveSplits] = useAtom(
    dimInactiveSplitsAtom,
  );
  const slots = usePluginSlots();
  const paletteSelectedRef = useRef(false);
  const palettes = builtInThemes.map((entry) => ({
    value: entry.id,
    content: entry.name,
  }));
  const providerChoices: ProviderChoiceProps[] = [
    {
      label: "Sidebar",
      description: "Choose the plugin that renders your sidebar thread list.",
      atom: threadListProviderAtom,
      slots: slots.threadLists,
      bundled: BUNDLED_THREAD_LIST_PROVIDER,
    },
    {
      label: "Navigation",
      description:
        "Choose who arranges the host-owned sidebar destinations on this device.",
      atom: sidebarNavigationProviderAtom,
      slots: slots.sidebarNavigations,
      bundled: BUNDLED_NAVIGATION_PROVIDER,
    },
    {
      label: "Header",
      description:
        "Choose what appears beside the sidebar toggle on this device.",
      atom: sidebarHeaderProviderAtom,
      slots: slots.sidebarHeaders,
      builtIn: true,
    },
  ].filter((choice) => choice.slots.length + (choice.builtIn ? 1 : 0) > 1);
  const pending = disabled || updateAppearance.isPending;
  return (
    <div className="space-y-6">
      <SettingsSection title="Appearance">
        <div className="space-y-5">
          <SettingsDropdown
            label="Theme"
            trigger={capitalize(themePreference)}
            value={themePreference}
            options={THEME_PREFERENCES.map((value) => ({
              value,
              content: capitalize(value),
            }))}
            onSelect={setPreferredTheme}
          />
          <SettingsDropdown
            label="Palette"
            description="Palettes change bb's colors, including syntax colors in diffs and file previews."
            disabled={pending}
            trigger={
              <span className="min-w-0 truncate">
                {builtInThemes.find((entry) => entry.id === appearance.themeId)
                  ?.name ?? appearance.themeId}
              </span>
            }
            value={appearance.themeId}
            options={palettes}
            onOpenChange={(open) => {
              if (!open) {
                if (!paletteSelectedRef.current) preview.previewTheme(null);
                return;
              }
              paletteSelectedRef.current = false;
              preview.prefetchThemes(palettes.map((entry) => entry.value));
            }}
            onPreview={(themeId) => {
              if (themeId !== null || !paletteSelectedRef.current)
                preview.previewTheme(themeId);
            }}
            onSelect={(themeId) => {
              paletteSelectedRef.current = true;
              updateAppearance.mutate(
                { themeId, faviconColor: appearance.faviconColor },
                { onError: () => preview.previewTheme(null) },
              );
            }}
          />
          <SettingsDropdown
            label="Favicon color"
            description="Tint browser tabs to tell instances apart."
            disabled={pending}
            trigger={
              <span className="flex min-w-0 items-center gap-2">
                <FaviconColorPreview value={appearance.faviconColor} />
                <span className="min-w-0 truncate">
                  {capitalize(appearance.faviconColor)}
                </span>
              </span>
            }
            value={appearance.faviconColor}
            options={faviconColorPreferenceSchema.options.map((value) => ({
              value,
              content: (
                <>
                  <FaviconColorPreview value={value} />
                  {capitalize(value)}
                </>
              ),
            }))}
            onSelect={(faviconColor) =>
              updateAppearance.mutate({
                themeId: appearance.themeId,
                faviconColor,
              })
            }
          />
          <SettingsSwitch
            label="Fade inactive splits"
            description="Fade out splits that do not have focus."
            checked={dimsInactiveSplits}
            onChange={setDimsInactiveSplits}
          />
        </div>
      </SettingsSection>
      {providerChoices.length === 0 ? null : (
        <SettingsSection title="Interface">
          <div className="space-y-5">
            {providerChoices.map((choice) => (
              <ProviderChoice key={choice.label} {...choice} />
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

function GeneralSettingsSection({
  disabled,
  settings,
  update,
}: {
  disabled: boolean;
  settings: AppSettings;
  update: UpdateSettings;
}) {
  const [rewriteLocalhostLinks, setRewriteLocalhostLinks] =
    useRewriteLocalhostLinksPreference();
  const [navigateToThreadAfterCreate, setNavigateToThreadAfterCreate] =
    useNavigateToThreadAfterCreatePreference();
  const localhostRewriteDescription = localhostLinkRewriteDescription(
    window.location.hostname,
  );
  return (
    <>
      <SettingsSection title="Threads & editing">
        <div className="space-y-5">
          <SettingsSwitch
            label="Navigate to threads on creation"
            checked={navigateToThreadAfterCreate}
            onChange={setNavigateToThreadAfterCreate}
          />
          <SettingsDropdown
            label="Default thread followup behavior"
            description="What Enter does in the prompt box while the thread runs."
            disabled={disabled}
            trigger={settings.steerActiveThreadOnEnter ? "Steer" : "Queue"}
            value={settings.steerActiveThreadOnEnter}
            contentClassName="max-w-72"
            options={FOLLOW_UP_OPTIONS.map((option) => ({
              value: option.value,
              className: "items-start",
              content: (
                <span className="min-w-0">
                  <span className="block">{option.label}</span>
                  <span className="block text-2xs leading-snug text-subtle-foreground">
                    {option.description}
                  </span>
                </span>
              ),
            }))}
            onSelect={(steerActiveThreadOnEnter) =>
              update({ steerActiveThreadOnEnter })
            }
          />
          <SettingsSwitch
            label="Thread archive confirmation"
            description="Ask before archiving a thread with unarchived children."
            checked={settings.confirmThreadArchive}
            disabled={disabled}
            onChange={(confirmThreadArchive) =>
              update({ confirmThreadArchive })
            }
          />
        </div>
      </SettingsSection>
      {localhostRewriteDescription !== null ? (
        <SettingsSection title="Links">
          <div className="space-y-5">
            <SettingsSwitch
              label="Rewrite localhost links"
              description={
                <span className="break-words [overflow-wrap:anywhere]">
                  {localhostRewriteDescription}
                </span>
              }
              checked={rewriteLocalhostLinks}
              onChange={setRewriteLocalhostLinks}
            />
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Git">
        <div className="space-y-5">
          <ManagedBranchPrefixSetting
            value={settings.managedBranchPrefix}
            disabled={disabled}
            onChange={(managedBranchPrefix, onError) =>
              update({ managedBranchPrefix }, { onError })
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection title="Privacy & diagnostics">
        <div className="space-y-5">
          <SettingsSwitch
            label="Streamer mode"
            description="Hide the custom models from config.json in every model picker, so a screen share does not show them."
            checked={settings.streamerMode}
            disabled={disabled}
            onChange={(streamerMode) => update({ streamerMode })}
          />
          <SettingsSwitch
            label="Show diagnostic events"
            description="Show provider environment resolution and unhandled provider events for troubleshooting."
            checked={settings.showDiagnosticEvents}
            disabled={disabled}
            onChange={(showDiagnosticEvents) =>
              update({ showDiagnosticEvents })
            }
          />
        </div>
      </SettingsSection>
    </>
  );
}

export function SettingsView() {
  const config = useSystemConfig().data;
  const updateGeneralSettings = useUpdateGeneralSettings();
  const { activePluginId, activeSection, hasUnknownSection } =
    useSettingsNavState();
  if (hasUnknownSection) return <Navigate to={SETTINGS_ROUTE_PATH} replace />;
  const settings = config?.generalSettings ?? defaultAppSettings;
  const disabled = config === undefined || updateGeneralSettings.isPending;
  const update: UpdateSettings = (patch, options) =>
    updateGeneralSettings.mutate({ ...settings, ...patch }, options);
  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-10">
        {activePluginId !== null ? (
          <PluginSettingsPage pluginId={activePluginId} />
        ) : activeSection === "plugins" ? (
          <InstalledPluginsSettingsSection />
        ) : activeSection === "providers" ? (
          <ProvidersSettingsSection
            disabled={disabled}
            settings={settings}
            update={update}
          />
        ) : activeSection === "appearance" ? (
          <AppearanceSettingsSection
            appearance={config?.appearance ?? defaultAppTheme}
            disabled={config === undefined}
          />
        ) : activeSection === "keyboard" ? (
          <KeyboardSettingsSection />
        ) : activeSection === "projects" ? (
          <ProjectsSettingsSection />
        ) : activeSection === "machines" ? (
          <>
            <MachinesSettingsSection />
            <MachineAccessSettings />
          </>
        ) : activeSection === "environment-variables" ? (
          <MachineEnvironmentSettings />
        ) : activeSection === "archived" ? (
          <ArchivedThreadsSettingsSection />
        ) : (
          <GeneralSettingsSection
            disabled={disabled}
            settings={settings}
            update={update}
          />
        )}
      </div>
    </PageShell>
  );
}
