import { useAtom, type WritableAtom } from "jotai";
import {
  AUTOMATIC_PROVIDER,
  NO_PROVIDER,
  findAutomaticProvider,
  providerKey,
} from "@/plugins/registry";
import { ChoiceDropdownSetting } from "./ChoiceDropdownSetting";

interface ReplacementProviderSlot {
  pluginId: string;
  id: string;
  title: string;
  description?: string;
}

export function ReplacementProviderSetting({
  label,
  description,
  triggerAriaLabel,
  builtInDescription,
  allowAutomatic = true,
  bundledProvider,
  preferenceAtom,
  slots,
}: {
  label: string;
  description: string;
  triggerAriaLabel: string;
  builtInDescription?: string;
  allowAutomatic?: boolean;
  bundledProvider?: string;
  preferenceAtom: WritableAtom<string, [string], void>;
  slots: readonly ReplacementProviderSlot[];
}) {
  const [preference, setPreference] = useAtom(preferenceAtom);

  const automaticProvider = findAutomaticProvider(slots, bundledProvider);
  if (automaticProvider === undefined) return null;
  const automaticOption = {
    key: AUTOMATIC_PROVIDER,
    title: "Automatic",
    description: `Chooses ${automaticProvider.title} (${
      providerKey(automaticProvider) === bundledProvider
        ? "built-in"
        : automaticProvider.pluginId
    }).`,
  };
  const builtInOption =
    builtInDescription === undefined
      ? null
      : {
          key: NO_PROVIDER,
          title: "bb (built-in)",
          description: builtInDescription,
        };
  const pluginOptions = slots.map((slot) => {
    const bundled = providerKey(slot) === bundledProvider;
    return {
      key: providerKey(slot),
      title: bundled ? `${slot.title} (built-in)` : slot.title,
      description: bundled
        ? `BB default. ${slot.description ?? ""}`.trim()
        : slot.description === undefined
          ? `From the ${slot.pluginId} plugin.`
          : `${slot.pluginId} plugin. ${slot.description}`,
    };
  });
  const options = [
    ...(allowAutomatic ? [automaticOption] : []),
    ...pluginOptions.filter((option) => option.key !== bundledProvider),
    ...pluginOptions.filter((option) => option.key === bundledProvider),
    ...(builtInOption === null ? [] : [builtInOption]),
  ];
  const selected =
    options.find((option) => option.key === preference) ??
    builtInOption ??
    (allowAutomatic
      ? automaticOption
      : { key: preference, title: "Unavailable plugin" });

  return (
    <ChoiceDropdownSetting
      label={label}
      description={description}
      triggerAriaLabel={triggerAriaLabel}
      options={options}
      selected={selected}
      onSelect={setPreference}
    />
  );
}
