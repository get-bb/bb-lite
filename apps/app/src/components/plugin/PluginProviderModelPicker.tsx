import { useCallback, useEffect, useMemo } from "react";
import type {
  ProviderModelPickerProps,
  ProviderModelPickerValue,
} from "@bb/plugin/app";
import { ModelReasoningPicker } from "@/components/pickers/ModelReasoningPicker";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { resolvePluginExecutionRouting } from "./plugin-execution-routing";

function selectionKey(value: ProviderModelPickerValue): string {
  return [
    value.providerId,
    value.model,
    value.reasoningLevel,
    value.serviceTier ?? "",
  ].join("\0");
}

export function PluginProviderModelPicker({
  value,
  onChange,
  routing,
  allowProviderChange = true,
  align = "start",
  disabled,
  className,
}: ProviderModelPickerProps) {
  const resolvedRouting = useMemo(
    () => resolvePluginExecutionRouting(routing),
    [routing],
  );
  const controlledKey = `${resolvedRouting.key}\0${selectionKey(value)}`;
  const controller = useThreadCreationOptions({
    scope: "component-local",
    initialProviderId: value.providerId,
    initialModel: value.model,
    initialReasoningLevel: value.reasoningLevel,
    initialServiceTier: value.serviceTier,
    resetKey: controlledKey,
    routing: resolvedRouting.query,
  });

  const emit = useCallback(
    (next: ProviderModelPickerValue) => {
      if (selectionKey(next) !== selectionKey(value)) {
        onChange(next);
      }
    },
    [onChange, value],
  );

  useEffect(() => {
    if (
      !controller.modelCatalogIsVerified ||
      controller.selectedModel.length === 0
    ) {
      return;
    }
    emit({
      providerId: controller.selectedProviderId,
      model: controller.selectedModel,
      reasoningLevel: controller.reasoningLevel,
      ...(controller.serviceTier === undefined
        ? {}
        : { serviceTier: controller.serviceTier }),
    });
  }, [
    controller.modelCatalogIsVerified,
    controller.reasoningLevel,
    controller.selectedModel,
    controller.selectedProviderId,
    controller.serviceTier,
    emit,
  ]);

  const handleModelChange = useCallback(
    (model: string) => {
      if (!controller.modelCatalogIsVerified) return;
      controller.setSelectedModel(model);
    },
    [controller],
  );
  const handleReasoningChange = useCallback(
    (reasoningLevel: ProviderModelPickerValue["reasoningLevel"]) => {
      if (!controller.modelCatalogIsVerified) return;
      emit({
        providerId: controller.selectedProviderId,
        model: controller.selectedModel,
        reasoningLevel,
        ...(controller.serviceTier === undefined
          ? {}
          : { serviceTier: controller.serviceTier }),
      });
    },
    [controller, emit],
  );
  const handleFastModeChange = useCallback(
    (enabled: boolean) => {
      if (
        !controller.modelCatalogIsVerified ||
        !controller.supportsServiceTier
      ) {
        return;
      }
      emit({
        providerId: controller.selectedProviderId,
        model: controller.selectedModel,
        reasoningLevel: controller.reasoningLevel,
        serviceTier: enabled ? "fast" : "default",
      });
    },
    [controller, emit],
  );
  return (
    <ModelReasoningPicker
      provider={{
        options: controller.providerOptions,
        selectedId: controller.selectedProviderId,
        onChange: allowProviderChange
          ? controller.setSelectedProviderId
          : undefined,
        hasMultiple: controller.hasMultipleProviders,
      }}
      model={{
        selected: controller.selectedModel,
        options: controller.modelOptions,
        moreOptions: controller.moreModelOptions,
        isLoading: controller.isLoadingModels,
        loadFailed: controller.modelLoadFailed,
        loadError: controller.modelLoadError,
        onChange: handleModelChange,
      }}
      reasoning={{
        value: controller.reasoningLevel,
        options: controller.reasoningOptions,
        onChange: handleReasoningChange,
      }}
      serviceTier={{
        value: controller.serviceTier,
        onChange: (tier) => handleFastModeChange(tier === "fast"),
        supported: controller.supportsServiceTier,
      }}
      commandShortcutsEnabled={false}
      align={align}
      disabled={disabled}
      className={className}
    />
  );
}
