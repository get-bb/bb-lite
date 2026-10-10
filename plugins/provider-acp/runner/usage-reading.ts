import type { UsageReading } from "@bb/plugin";
import type { ProviderUsageResult } from "./maintenance-types.js";

export function usageReading(result: ProviderUsageResult): UsageReading {
  if (!result.supported) return null;
  const { usage } = result;
  if (usage.status !== "ok") return usage;
  return {
    status: "ok",
    accountEmail: usage.accountEmail,
    planLabel: usage.planLabel,
    windows: usage.windows.map(({ label, usedPercent, resetsAt, cost }) => ({
      label,
      usedPercent,
      resetsAt,
      ...(cost === undefined ? {} : { cost }),
    })),
  };
}
