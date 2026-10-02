import type { PermissionMode } from "@bb/domain";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import { OptionPicker, type PickerOption } from "./OptionPicker";

const COMPACT_LABELS: Record<PermissionMode, string> = {
  full: "Full",
  "accept-edits": "Edits",
  auto: "Auto",
};

interface PermissionModePickerProps {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
  className?: string;
  align?: "start" | "center" | "end";
  displayOverride?: {
    label: string;
    compactLabel?: string;
    description?: string;
    title?: string;
  };
  disabled?: boolean;
  showChevronWhenDisabled?: boolean;
  showWhenSingleOption?: boolean;
}

export function PermissionModePicker({
  value,
  options,
  onChange,
  supported,
  className,
  align = "end",
  displayOverride,
  disabled,
  showChevronWhenDisabled,
  showWhenSingleOption = false,
}: PermissionModePickerProps) {
  if (
    !supported ||
    value === undefined ||
    (!showWhenSingleOption && options.length <= 1)
  ) {
    return null;
  }
  return (
    <OptionPicker
      label="Permission mode"
      value={value}
      options={options.map((option) => ({
        ...option,
        compactLabel: option.compactLabel ?? COMPACT_LABELS[option.value],
      }))}
      onChange={onChange}
      className={cn(LIST_HOVER_TRANSITION, className)}
      caretClassName="text-subtle-foreground/75"
      contentClassName="max-w-72"
      muted
      align={align}
      displayOverride={displayOverride}
      disabled={disabled || options.length <= 1}
      showChevronWhenDisabled={showChevronWhenDisabled}
    />
  );
}
