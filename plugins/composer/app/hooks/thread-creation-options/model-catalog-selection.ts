import {
  collectDeclaredSessionOptions,
  describeSessionOptionConflict,
  effectiveSessionOptionSelections,
  modelSessionOptionConflict,
  type AvailableModel,
  type SessionOptionSelections,
} from "@bb/domain";
import type { PickerOption } from "@bb/app-kit/components/pickers/OptionPicker";

export function formatModelLabel(value: string): string {
  return value
    .split("-")
    .map((part) =>
      part.toLowerCase() === "gpt"
        ? "GPT"
        : /^[a-z]+$/i.test(part)
          ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
          : part,
    )
    .join("-");
}

export function resolveModelCatalogSelection({
  models,
  selectedOnlyModels,
  rawSelectedModel,
  catalogIsVerified,
  sessionOptionSelections: requestedSessionOptionSelections,
}: {
  models: readonly AvailableModel[];
  selectedOnlyModels: readonly AvailableModel[];
  rawSelectedModel: string;
  catalogIsVerified: boolean;
  sessionOptionSelections?: SessionOptionSelections;
}) {
  const fullCatalog = [...models, ...selectedOnlyModels];
  const declaredSessionOptions = collectDeclaredSessionOptions(fullCatalog);
  const sessionOptionSelections = effectiveSessionOptionSelections(
    declaredSessionOptions,
    requestedSessionOptionSelections ?? {},
  );
  const suffixMatches = fullCatalog.filter((model) =>
    model.model.endsWith(`/${rawSelectedModel}`),
  );
  const requested =
    rawSelectedModel.length === 0 ||
    fullCatalog.some((model) => model.model === rawSelectedModel) ||
    suffixMatches.length !== 1
      ? rawSelectedModel
      : suffixMatches[0]!.model;
  const requestedOnly = models.some((model) => model.model === requested)
    ? undefined
    : selectedOnlyModels.find((model) => model.model === requested);
  const availableModels = requestedOnly ? [requestedOnly, ...models] : models;
  const fallback =
    availableModels.find((model) => model.isDefault) ?? availableModels[0];
  const catalogSelectedModel =
    (!catalogIsVerified && requested) ||
    fallback === undefined ||
    availableModels.some((model) => model.model === requested)
      ? requested
      : fallback.model;
  const selectedModel = (() => {
    const chosen = availableModels.find(
      (model) => model.model === catalogSelectedModel,
    );
    if (
      chosen === undefined ||
      modelSessionOptionConflict(chosen, sessionOptionSelections) === null
    ) {
      return catalogSelectedModel;
    }
    const compatible = availableModels.filter(
      (model) =>
        modelSessionOptionConflict(model, sessionOptionSelections) === null,
    );
    return (
      (compatible.find((model) => model.isDefault) ?? compatible[0])?.model ??
      catalogSelectedModel
    );
  })();
  const toOption = (model: AvailableModel): PickerOption<string> => {
    const conflict = modelSessionOptionConflict(model, sessionOptionSelections);
    return {
      value: model.model,
      label: formatModelLabel(model.displayName || model.model),
      ...(conflict === null
        ? {}
        : {
            disabled: true,
            disabledReason: describeSessionOptionConflict(conflict),
          }),
    };
  };
  return {
    selectedModel,
    activeModel:
      availableModels.find((model) => model.model === selectedModel) ??
      fallback,
    modelOptions: availableModels.map(toOption),
    moreModelOptions: selectedOnlyModels
      .filter(
        (model) =>
          !availableModels.some((active) => active.model === model.model),
      )
      .map(toOption),
    isUnavailableModelRecovery:
      catalogIsVerified &&
      rawSelectedModel.length > 0 &&
      catalogSelectedModel !== rawSelectedModel,
    declaredSessionOptions,
    sessionOptionSelections,
    isSessionOptionModelSwitch: selectedModel !== catalogSelectedModel,
  };
}
