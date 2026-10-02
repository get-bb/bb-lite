import { useState } from "react";
import type { ServerAccessStatus } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { OptionPicker } from "@/components/pickers/OptionPicker";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { isLocalOnlyUrl } from "@/lib/loopback-hostname";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

export function machineServerAccessReady(
  access: ServerAccessStatus | undefined,
): boolean {
  return (
    access !== undefined &&
    access.effectiveUrl !== null &&
    !isLocalOnlyUrl(access.effectiveUrl)
  );
}

function addressError(url: string): string | null {
  if (!url) return null;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  const credentials = `${parsed?.username}${parsed?.password}`;
  if (!parsed || !/^https?:$/u.test(parsed.protocol) || credentials)
    return "Enter a valid HTTP or HTTPS URL without credentials";
  return isLocalOnlyUrl(url)
    ? "Other machines cannot reach localhost. Use a domain or shared-network address."
    : null;
}

function MethodPicker({
  access,
  align,
}: {
  access: ServerAccessStatus | undefined;
  align: "start" | "end";
}) {
  return (
    <OptionPicker
      modal={false}
      label="Connection method"
      value={access?.defaultProviderId ?? "direct"}
      disabled={access === undefined}
      showChevronWhenDisabled
      align={align}
      className={align === "start" ? "-ml-1" : undefined}
      options={(access?.providers ?? []).map((provider) => ({
        value: provider.id,
        label: provider.displayName,
        description: provider.description,
      }))}
      onChange={() => {}}
    />
  );
}

function ServerAddress({ access }: { access: ServerAccessStatus | undefined }) {
  const settings = useSystemConfig().data?.generalSettings;
  const update = useUpdateGeneralSettings();
  const value = settings?.machineServerUrl ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = !settings || update.isPending;
  const commit = () => {
    if (!settings || draft === null) return;
    const url = draft.trim();
    const invalid = addressError(url);
    if (invalid !== null) return setError(invalid);
    update.mutate(
      { ...settings, machineServerUrl: url || null },
      {
        onSuccess: () => setDraft(null),
        onError: (saveError) =>
          setError(
            getMutationErrorMessage({
              error: saveError,
              fallbackMessage: "Couldn't save the address.",
            }),
          ),
      },
    );
  };
  return (
    <SettingsWithControl
      label="Server address"
      description="Use your own domain or an address on a shared network. Your devices must be able to reach this address; localhost won’t work."
      controlPlacement="below"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-0 flex-1 basis-48"
          aria-label="Server address"
          aria-invalid={error !== null}
          value={draft ?? value}
          placeholder={access?.effectiveUrl ?? "https://bb.example.com"}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
        <Button
          variant="outline"
          className="h-9"
          disabled={disabled || draft === null || draft.trim() === value}
          onClick={commit}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-destructive-text">
          {error}
        </p>
      )}
    </SettingsWithControl>
  );
}

export function MachineAccessSettings() {
  const config = useSystemConfig().data;
  const access = config?.serverAccess;
  return (
    <section aria-label="Machine access" className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Machine access</h2>
        <p className="mt-1 text-xs text-subtle-foreground">
          Choose how your devices reach this bb server.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="px-4 py-3">
          {access === undefined ? (
            <p
              role="status"
              className="flex h-8 items-center gap-2 text-xs text-subtle-foreground"
            >
              <Icon name="Spinner" className="size-3.5 animate-spin" />
              Loading connection settings…
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex">
                <MethodPicker access={access} align="start" />
              </div>
              <ServerAddress access={access} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function MachineAccessControls() {
  const access = useSystemConfig().data?.serverAccess;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-normal text-foreground">
          Connection method
        </span>
        <MethodPicker access={access} align="end" />
      </div>
      <ServerAddress access={access} />
    </div>
  );
}
