import { describe, expect, it } from "vitest";
import type { AvailableModel, ThreadSessionOption } from "@bb/domain";
import { resolveModelCatalogSelection } from "../app/hooks/thread-creation-options/model-catalog-selection";
import {
  parseStoredSessionOptionSelections,
  serializeSessionOptionSelections,
} from "../app/hooks/thread-creation-options/persisted-selection-fields";
import { threadProviderCommandSuggestions } from "../app/hooks/useCommandSuggestions";
import {
  buildSessionOptionMenuSections,
  splitSessionOptionsByPlacement,
  threadSessionOptionViews,
} from "../app/components/pickers/SessionOptionsMenu";

function approach(
  values: readonly string[],
  value: string = values[0] ?? "build",
): ThreadSessionOption {
  return {
    id: "approach",
    label: "Approach",
    category: "mode",
    type: "select",
    value,
    values: values.map((id) => ({ id, label: id })),
  };
}

function model(
  id: string,
  isDefault: boolean,
  sessionOptions: ThreadSessionOption[],
): AvailableModel {
  return {
    id,
    model: id,
    displayName: id,
    description: "",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    isDefault,
    sessionOptions,
  };
}

const MODELS = [
  model("small", true, [approach(["build"])]),
  model("large", false, [approach(["build", "plan"])]),
];

describe("resolveModelCatalogSelection with session options", () => {
  it("keeps the chosen model when it fits the choices", () => {
    const result = resolveModelCatalogSelection({
      models: MODELS,
      selectedOnlyModels: [],
      rawSelectedModel: "small",
      catalogIsVerified: true,
    });
    expect(result.selectedModel).toBe("small");
    expect(result.isSessionOptionModelSwitch).toBe(false);
    expect(result.declaredSessionOptions.map((option) => option.id)).toEqual([
      "approach",
    ]);
  });

  it("disables a model that rules the choices out and moves to one that fits", () => {
    const result = resolveModelCatalogSelection({
      models: MODELS,
      selectedOnlyModels: [],
      rawSelectedModel: "small",
      catalogIsVerified: true,
      sessionOptionSelections: { approach: "plan" },
    });
    expect(result.selectedModel).toBe("large");
    expect(result.isSessionOptionModelSwitch).toBe(true);
    const small = result.modelOptions.find(
      (option) => option.value === "small",
    );
    expect(small?.disabled).toBe(true);
    expect(small?.disabledReason).toEqual(expect.any(String));
    expect(
      result.modelOptions.find((option) => option.value === "large")?.disabled,
    ).toBeUndefined();
  });
});

describe("stored session option selections", () => {
  it("round-trips and rejects malformed values", () => {
    const stored = serializeSessionOptionSelections({
      approach: "plan",
      web: true,
    });
    expect(parseStoredSessionOptionSelections(stored)).toEqual({
      approach: "plan",
      web: true,
    });
    expect(serializeSessionOptionSelections({})).toBe("");
    expect(parseStoredSessionOptionSelections("not json")).toEqual({});
    expect(parseStoredSessionOptionSelections('{"a":1}')).toEqual({});
    expect(parseStoredSessionOptionSelections(null)).toEqual({});
  });
});

describe("thread session option views", () => {
  const options: ThreadSessionOption[] = [
    approach(["build", "plan"], "plan"),
    { id: "web", label: "Web", type: "boolean", value: false },
  ];

  it("places the mode in the footer and shows pending choices as chosen", () => {
    const views = threadSessionOptionViews(options, { approach: "plan" });
    const placed = splitSessionOptionsByPlacement(views);
    expect(placed.footer.map((option) => option.id)).toEqual(["approach"]);
    const [mode] = buildSessionOptionMenuSections(placed.footer, {});
    expect(mode?.selectedLabel).toBe("plan");
    expect(mode?.appliesOnNextTurn).toBe(true);
    const [web] = buildSessionOptionMenuSections(placed.picker, { web: true });
    expect(web?.items.find((item) => item.selected)?.value).toBe(true);
    expect(web?.appliesOnNextTurn).toBe(true);
  });
});

describe("threadProviderCommandSuggestions", () => {
  const commands = [
    { name: "review", description: "Review the diff" },
    { name: "web", inputHint: "query" },
  ];

  it("lists the agent's commands for / only", () => {
    expect(
      threadProviderCommandSuggestions({ commands, query: "", trigger: "/" }),
    ).toHaveLength(2);
    expect(
      threadProviderCommandSuggestions({ commands, query: "", trigger: "$" }),
    ).toEqual([]);
    const [web] = threadProviderCommandSuggestions({
      commands,
      query: "we",
      trigger: "/",
    });
    expect(web?.name).toBe("web");
    expect(web?.argumentHint).toBe("query");
  });
});
