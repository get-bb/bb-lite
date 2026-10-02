import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@bb/shared-ui/input";
import {
  ResourceDetailConfigurationSection,
  ResourceDetailPanel,
  ResourceDetailStack,
} from "@bb/shared-ui/resource-list";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { Switch } from "@bb/shared-ui/switch";
import { Textarea } from "@bb/shared-ui/textarea";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { useSetPluginEnabled } from "@/components/plugin/useSetPluginEnabled";
import { appToast } from "@/components/ui/app-toast";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import { useSetProviderEnabled } from "@/hooks/mutations/provider-mutations";
import {
  applyPluginSettingsView,
  invalidatePluginList,
  updatePluginSettings,
  usePluginList,
  usePluginSettingsView,
  type PluginListItem,
  type PluginSettingFieldDescriptor,
} from "@/hooks/queries/plugin-settings-queries";
import { useSystemProviderCatalog } from "@/hooks/queries/system-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import { PluginSlotMount } from "@/plugins/mount";
import { usePluginSlots } from "@/plugins/registry";

function PluginSetting({
  descriptor,
  pluginId,
  settingKey,
  storedValue,
}: {
  descriptor: PluginSettingFieldDescriptor;
  pluginId: string;
  settingKey: string;
  storedValue: unknown;
}) {
  const queryClient = useQueryClient();
  const messageId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    scope: { id: `plugin-setting:${pluginId}:${settingKey}` },
    mutationFn: (value: string | boolean) =>
      updatePluginSettings(pluginId, { [settingKey]: value }),
    onSuccess: (view) => {
      applyPluginSettingsView({ queryClient, pluginId, view });
      setDraft(null);
    },
  });
  const error = save.isError
    ? getMutationErrorMessage({
        error: save.error,
        fallbackMessage: "Could not save this setting",
      })
    : null;
  const aria = {
    "aria-label": descriptor.label,
    "aria-describedby": error === null ? undefined : messageId,
    "aria-invalid": error !== null,
  };
  const secret = descriptor.type === "string" && descriptor.secret === true;
  const multiline =
    descriptor.type === "string" && descriptor.multiline === true && !secret;
  const stored = save.isPending ? save.variables : storedValue;
  const text = draft ?? (secret || typeof stored !== "string" ? "" : stored);
  const textProps = {
    ...aria,
    value: text,
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value);
      if (!save.isPending) save.reset();
    },
    onBlur: () => {
      if (draft === null) return;
      if (draft === (storedValue ?? null) || (secret && draft === ""))
        setDraft(null);
      else save.mutate(draft);
    },
  };
  return (
    <SettingsWithControl
      label={descriptor.label}
      labelBadge={secret ? "secret" : undefined}
      controlPlacement={
        descriptor.type === "boolean"
          ? "trailing"
          : multiline
            ? "below"
            : "inline"
      }
      description={descriptor.description}
    >
      <div className="space-y-1">
        {descriptor.type === "boolean" ? (
          <Switch
            checked={stored === true}
            onCheckedChange={(checked) => save.mutate(checked)}
            {...aria}
          />
        ) : multiline ? (
          <Textarea
            {...textProps}
            rows={Math.min(24, Math.max(6, text.split("\n").length + 1))}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="max-h-96 min-h-32 w-full resize-y overflow-y-auto font-mono text-xs field-sizing-content"
          />
        ) : (
          <Input
            {...textProps}
            type={secret ? "password" : "text"}
            placeholder={
              !secret
                ? undefined
                : typeof storedValue === "object" &&
                    storedValue !== null &&
                    "set" in storedValue &&
                    storedValue.set === true
                  ? "[set]"
                  : "[not set]"
            }
            className="h-7 w-full text-xs sm:w-64"
          />
        )}
        {error !== null ? (
          <p id={messageId} className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsWithControl>
  );
}

function PluginSettingsForm({ pluginId }: { pluginId: string }) {
  const view = usePluginSettingsView(pluginId, { enabled: true }).data;
  if (!view || Object.keys(view.schema).length === 0) return null;
  return (
    <div className="space-y-4">
      {Object.entries(view.schema).map(([key, descriptor]) => (
        <PluginSetting
          key={key}
          descriptor={descriptor}
          pluginId={pluginId}
          settingKey={key}
          storedValue={view.values[key]}
        />
      ))}
    </div>
  );
}

function usePluginEnabledMutation(plugin: PluginListItem) {
  const queryClient = useQueryClient();
  const setEnabled = useSetPluginEnabled();
  const toggle = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (enabled: boolean) => setEnabled(plugin.id, enabled),
    onError: (error, enabled) => {
      appToast.error(
        `${enabled ? "Enabling" : "Disabling"} ${plugin.id} failed`,
        { description: error instanceof Error ? error.message : String(error) },
      );
    },
    onSettled: () => invalidatePluginList({ queryClient }),
  });
  return {
    pending: toggle.isPending,
    enabled: toggle.isPending ? toggle.variables : plugin.enabled,
    setEnabled: toggle.mutate,
  };
}

function InstalledPluginRow({ plugin }: { plugin: PluginListItem }) {
  const toggle = usePluginEnabledMutation(plugin);
  return (
    <SettingsRow data-testid={`plugin-row-${plugin.id}`}>
      <PluginIcon
        pluginId={plugin.id}
        icon={plugin.icon}
        compactIconUrl={plugin.compactIconUrl}
        className="size-4 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <Link
          to={getPluginConfigurationRoutePath({ pluginId: plugin.id })}
          className="block truncate text-foreground underline-offset-2 hover:underline"
        >
          {plugin.name}
        </Link>
        {plugin.description ? (
          <p className="truncate text-xs text-subtle-foreground">
            {plugin.description}
          </p>
        ) : null}
      </div>
      <Switch
        checked={toggle.enabled}
        disabled={toggle.pending}
        onCheckedChange={toggle.setEnabled}
        aria-label={`${toggle.enabled ? "Disable" : "Enable"} ${plugin.id}`}
      />
    </SettingsRow>
  );
}

export function InstalledPluginsSettingsSection() {
  const listQuery = usePluginList({ enabled: true });
  const plugins = [...(listQuery.data?.plugins ?? [])].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  return (
    <SettingsSection title="Installed plugins">
      {listQuery.data === undefined ? (
        <p className="text-sm text-muted-foreground" role="status">
          {listQuery.isError ? "Couldn't load plugins." : "Loading plugins"}
        </p>
      ) : plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plugins installed.</p>
      ) : (
        <SettingsRowList>
          {plugins.map((plugin) => (
            <InstalledPluginRow key={plugin.id} plugin={plugin} />
          ))}
        </SettingsRowList>
      )}
    </SettingsSection>
  );
}

function SettingsPageFrame({
  id,
  name,
  description,
  icon,
  compactIconUrl,
  enabled,
  pending,
  onEnabledChange,
  children,
}: {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  compactIconUrl?: string | null;
  enabled: boolean;
  pending: boolean;
  onEnabledChange: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-9 shrink-0">
            <PluginIcon
              pluginId={id}
              icon={icon}
              compactIconUrl={compactIconUrl}
              className="size-full"
            />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-foreground">
              {name}
            </h1>
            {description ? (
              <p className="truncate text-xs text-subtle-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        <Switch
          className="mr-[13px]"
          checked={enabled}
          disabled={pending}
          onCheckedChange={onEnabledChange}
          aria-label={`${enabled ? "Disable" : "Enable"} ${id}`}
        />
      </header>
      <ResourceDetailStack className="mt-6">
        {children ? (
          <ResourceDetailConfigurationSection label="Configuration">
            <div className="space-y-6" data-testid={`plugin-detail-${id}`}>
              {children}
            </div>
          </ResourceDetailConfigurationSection>
        ) : null}
      </ResourceDetailStack>
    </div>
  );
}

function PluginSettingsContent({ plugin }: { plugin: PluginListItem }) {
  const sections = usePluginSlots().settingsSections.filter(
    (section) => section.pluginId === plugin.id,
  );
  const toggle = usePluginEnabledMutation(plugin);
  const available = ["running", "needs-configuration"].includes(plugin.status);
  const shown =
    toggle.enabled &&
    plugin.enabled &&
    (plugin.hasSettings || sections.length > 0);
  return (
    <SettingsPageFrame
      {...plugin}
      enabled={toggle.enabled}
      pending={toggle.pending}
      onEnabledChange={toggle.setEnabled}
    >
      {shown ? (
        <>
          {plugin.hasSettings || !available ? (
            <ResourceDetailPanel className="px-3 py-3">
              {available ? (
                <PluginSettingsForm pluginId={plugin.id} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Settings are unavailable while the plugin is {plugin.status}.
                </p>
              )}
            </ResourceDetailPanel>
          ) : null}
          {available && sections.length > 0 ? (
            <div className="space-y-6" data-testid="plugin-settings-sections">
              {sections.map((section) => (
                <div
                  key={`${section.id}/${section.generation}`}
                  className="space-y-3"
                >
                  {section.title === undefined ? null : (
                    <h3 className="text-xs font-medium text-foreground">
                      {section.title}
                    </h3>
                  )}
                  {section.description === undefined ? null : (
                    <p className="text-xs leading-snug text-subtle-foreground/75">
                      {section.description}
                    </p>
                  )}
                  <PluginSlotMount
                    pluginId={section.pluginId}
                    slotKind="settingsSection"
                    slotId={section.id}
                  >
                    <section.component />
                  </PluginSlotMount>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsPageFrame>
  );
}

export function PluginSettingsPage({ pluginId }: { pluginId: string }) {
  const listQuery = usePluginList({ enabled: true });
  const provider = useSystemProviderCatalog().data?.find(
    (entry) => entry.pluginId === pluginId,
  );
  const setProviderEnabled = useSetProviderEnabled();
  const plugin = listQuery.data?.plugins.find((entry) => entry.id === pluginId);
  if (plugin) return <PluginSettingsContent key={plugin.id} plugin={plugin} />;
  if (provider) {
    return (
      <SettingsPageFrame
        id={pluginId}
        name={provider.pluginName}
        description={`Run bb threads with ${provider.displayName}.`}
        icon={null}
        compactIconUrl={provider.logoUrl}
        enabled={provider.enabled}
        pending={setProviderEnabled.isPending}
        onEnabledChange={(enabled) =>
          setProviderEnabled.mutate({ providerId: provider.id, enabled })
        }
      >
        {provider.enabled ? (
          <ResourceDetailPanel className="px-3 py-3">
            <PluginSettingsForm key={pluginId} pluginId={pluginId} />
          </ResourceDetailPanel>
        ) : null}
      </SettingsPageFrame>
    );
  }
  if (listQuery.data !== undefined || listQuery.isError) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {listQuery.isError
          ? "Could not load plugin settings."
          : "This plugin is not installed."}
      </p>
    );
  }
  return (
    <div className="mx-auto w-full max-w-5xl" role="status" aria-busy="true">
      <span className="sr-only">Loading plugin settings…</span>
      <div aria-hidden className="flex items-center gap-3">
        <Skeleton className="size-9 shrink-0" />
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-4 w-44 max-w-full" />
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
      </div>
    </div>
  );
}
