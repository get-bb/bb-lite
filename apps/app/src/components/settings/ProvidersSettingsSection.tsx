import type { AppSettings, ProviderInfo } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { useSetProviderEnabled } from "@/hooks/mutations/provider-mutations";
import {
  useSystemProviderCatalog,
  useSystemProviders,
} from "@/hooks/queries/system-queries";

function ProviderRowIcon({
  provider,
}: {
  provider: Pick<ProviderInfo, "id" | "logoUrl"> &
    Partial<Pick<ProviderInfo, "icon" | "strings">>;
}) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <ProviderIcon provider={provider} className="size-4" />
    </span>
  );
}

function ProviderActionsMenu({
  name,
  enabled,
  isDefault,
  disabled,
  onToggle,
  onMakeDefault,
}: {
  name: string;
  enabled: boolean;
  isDefault: boolean;
  disabled: boolean;
  onToggle: () => void;
  onMakeDefault: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground"
          aria-label={`Actions for ${name}`}
        >
          <Icon name="MoreHorizontal" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {enabled ? (
          <DropdownMenuCheckboxItem
            checked={isDefault}
            disabled={disabled || onMakeDefault === null}
            onCheckedChange={(checked) => {
              if (checked) onMakeDefault?.();
            }}
          >
            Default
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuItem
          disabled={disabled}
          onSelect={onToggle}
          variant={enabled ? "destructive" : "default"}
        >
          {enabled ? "Disable" : "Enable"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderRow({
  disabled,
  isDefault,
  provider,
  onDisable,
  onMakeDefault,
}: {
  disabled: boolean;
  isDefault: boolean;
  provider: ProviderInfo;
  onDisable: () => void;
  onMakeDefault: () => void;
}) {
  return (
    <SettingsRow>
      <ProviderRowIcon provider={provider} />
      <span className="min-w-0 flex-1 truncate font-medium">
        {provider.displayName}
      </span>
      {!provider.available ? (
        <SettingsBadge>Unavailable</SettingsBadge>
      ) : isDefault ? (
        <SettingsBadge>Default</SettingsBadge>
      ) : null}
      <ProviderActionsMenu
        name={provider.displayName}
        enabled
        isDefault={isDefault}
        disabled={disabled}
        onToggle={onDisable}
        onMakeDefault={provider.available ? onMakeDefault : null}
      />
    </SettingsRow>
  );
}

export function ProvidersSettingsSection({
  disabled,
  settings,
  update,
}: {
  disabled: boolean;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const providersQuery = useSystemProviders();
  const setEnabled = useSetProviderEnabled();
  const disabledProviders = (useSystemProviderCatalog().data ?? []).filter(
    (provider) => !provider.enabled || !provider.pluginEnabled,
  );
  const controlsDisabled = disabled || setEnabled.isPending;
  const providers = providersQuery.data ?? [];
  return (
    <SettingsSection
      title="Providers"
      description="Choose which agents you use in BB."
    >
      {providersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading providers…</p>
      ) : providers.length === 0 && disabledProviders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No providers available. Install a provider plugin in Settings →
          Plugins.
        </p>
      ) : (
        <SettingsRowList>
          {providers.map((provider, index) => (
            <ProviderRow
              key={provider.id}
              disabled={controlsDisabled}
              isDefault={
                settings.defaultProviderId === provider.id ||
                (settings.defaultProviderId === null && index === 0)
              }
              provider={provider}
              onDisable={() =>
                setEnabled.mutate({ providerId: provider.id, enabled: false })
              }
              onMakeDefault={() => update({ defaultProviderId: provider.id })}
            />
          ))}
          {disabledProviders.map((provider) => (
            <SettingsRow key={provider.id} className="text-muted-foreground">
              <span className="shrink-0 opacity-60 grayscale">
                <ProviderRowIcon provider={provider.info ?? provider} />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {provider.displayName}
              </span>
              <SettingsBadge>Disabled</SettingsBadge>
              <ProviderActionsMenu
                name={provider.displayName}
                enabled={false}
                isDefault={false}
                disabled={controlsDisabled}
                onToggle={() =>
                  setEnabled.mutate({ providerId: provider.id, enabled: true })
                }
                onMakeDefault={null}
              />
            </SettingsRow>
          ))}
        </SettingsRowList>
      )}
    </SettingsSection>
  );
}
