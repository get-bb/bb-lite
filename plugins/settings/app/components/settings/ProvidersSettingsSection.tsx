import type { AppSettings, ProviderInfo } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
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
} from "../ui/settings-section";
import { ProviderIcon } from "@bb/app-kit/components/plugin/ProviderIcon";
import { CopyButton } from "@bb/app-kit/components/ui/copy-button";
import { useSetProviderEnabled } from "../../hooks/mutations/provider-mutations";
import {
  useProviderStatus,
  useSystemProviderCatalog,
  useSystemProviders,
} from "@bb/app-kit/hooks/queries/system-queries";

function ProviderRowIcon({
  provider,
}: {
  provider: Pick<ProviderInfo, "id" | "logoUrl"> &
    Partial<Pick<ProviderInfo, "icon" | "strings">>;
}) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <ProviderIcon
        provider={provider}
        className={COARSE_POINTER_ICON_SIZE_CLASS}
      />
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
      <DropdownMenuContent align="end" mobileTitle={name}>
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

type ProviderStatus = NonNullable<
  ReturnType<typeof useProviderStatus>["data"]
>[number];

const STATUS_LABELS: Record<ProviderStatus["state"], string | null> = {
  ready: "Ready",
  needs_login: "Needs login",
  not_installed: "Not installed",
  update_required: "Update needed",
  unknown: null,
};

function ProviderStatusBadge({ status }: { status: ProviderStatus }) {
  const label = STATUS_LABELS[status.state];
  const command = status.installAction?.command;
  return (
    <>
      {label === null ? null : (
        <span title={status.message ?? undefined}>
          <SettingsBadge>{label}</SettingsBadge>
        </span>
      )}
      {command === undefined || status.state === "ready" ? null : (
        <span className="flex min-w-0 items-center gap-1">
          <code className="truncate text-xs text-muted-foreground">
            {command}
          </code>
          <CopyButton text={command} label="Copy command" />
        </span>
      )}
    </>
  );
}

function ProviderRow({
  disabled,
  isDefault,
  provider,
  status,
  onDisable,
  onMakeDefault,
}: {
  disabled: boolean;
  isDefault: boolean;
  provider: ProviderInfo;
  status: ProviderStatus | undefined;
  onDisable: () => void;
  onMakeDefault: () => void;
}) {
  return (
    <SettingsRow>
      <ProviderRowIcon provider={provider} />
      <span className="min-w-0 flex-1 truncate font-medium">
        {provider.displayName}
      </span>
      {status === undefined ? null : <ProviderStatusBadge status={status} />}
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
  const statuses = useProviderStatus().data ?? [];
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
              status={statuses.find(
                ({ providerId }) => providerId === provider.id,
              )}
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
