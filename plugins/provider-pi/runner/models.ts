import type { AvailableModel, ReasoningLevel } from "@bb/domain";
import type { ProviderModels } from "@bb/runner";
import { z } from "zod";

const LEVELS = [
  ["off", "none", "No extended thinking"],
  ["low", "low", "Light thinking"],
  ["medium", "medium", "Balanced thinking"],
  ["high", "high", "Deep thinking"],
  ["xhigh", "xhigh", "Extra deep thinking"],
  ["max", "max", "Maximum thinking"],
] as const;
const DATE_SUFFIX = /-\d{8}$|-\d{4}-\d{2}-\d{2}$/;

const modelSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  thinkingLevelMap: z.record(z.string(), z.unknown()).optional(),
});
const listSchema = z.object({ models: z.array(z.unknown()).default([]) });

function efforts(model: z.infer<typeof modelSchema>) {
  const [off] = LEVELS;
  if (!model.reasoning)
    return [{ reasoningEffort: off[1], description: off[2] }];
  return LEVELS.filter(([level]) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  }).map(([, reasoningEffort, description]) => ({
    reasoningEffort,
    description,
  }));
}

function toModel(model: z.infer<typeof modelSchema>): AvailableModel {
  const id = `${model.provider}/${model.id}`;
  const supported = efforts(model);
  const levels = supported.map((effort) => effort.reasoningEffort);
  const fallback: ReasoningLevel =
    levels.find((level) => level === "medium") ??
    levels.find((level) => level !== "none") ??
    "none";
  const capability = model.reasoning ? "reasoning" : "non-reasoning";
  const vision = model.input?.includes("image") ? ", image input" : "";
  return {
    id,
    model: id,
    displayName: model.name ?? model.id,
    description: `${model.provider} ${capability} model${vision}`,
    supportedReasoningEfforts: supported,
    defaultReasoningEffort: fallback,
    isDefault: false,
  };
}

export function piModels(data: unknown): ProviderModels {
  const raw = listSchema.safeParse(data);
  const models: AvailableModel[] = [];
  const selectedOnlyModels: AvailableModel[] = [];
  for (const entry of raw.success ? raw.data.models : []) {
    const parsed = modelSchema.safeParse(entry);
    if (!parsed.success) continue;
    const alias =
      parsed.data.id.endsWith("-latest") || !DATE_SUFFIX.test(parsed.data.id);
    (alias ? models : selectedOnlyModels).push(toModel(parsed.data));
  }
  const [first, ...rest] = models;
  if (first === undefined) return { models, selectedOnlyModels };
  return {
    models: [{ ...first, isDefault: true }, ...rest],
    selectedOnlyModels,
  };
}

export function piThinkingLevel(level: ReasoningLevel) {
  return level === "none" ? "off" : level;
}
