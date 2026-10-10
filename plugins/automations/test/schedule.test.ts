import { expect, it } from "vitest";
import {
  canToggle,
  describeCron,
  statusLabel,
  withCreateAutomationPrompt,
} from "../app/schedule.js";

it("describes common cron schedules as sentences", () => {
  expect(describeCron("* * * * *")).toBe("Every minute");
  expect(describeCron("*/15 * * * *")).toBe("Every 15 min");
  expect(describeCron("5 * * * *")).toBe("Hourly at :05");
  expect(describeCron("0 */2 * * *")).toBe("Every 2 hours at :00");
  expect(describeCron("0 9 * * *")).toBe("Daily at 9AM");
  expect(describeCron("30 17 * * 1-5")).toBe("Weekdays at 5:30PM");
  expect(describeCron("0 0 * * 0,6")).toBe("Weekends at 12AM");
  expect(describeCron("0 9,13 * * 1,3")).toBe("Mon, Wed at 9AM, 1PM");
  expect(describeCron("0 8 * * 2-4")).toBe("Tue-Thu at 8AM");
  expect(describeCron("0 12 1 * *")).toBe("Monthly on day 1 at 12PM");
  expect(describeCron("0 9 * 1 *")).toBe("Custom schedule");
  expect(describeCron("nonsense")).toBe("Custom schedule");
});

it("labels the state of recurring and one-shot automations", () => {
  const now = 1_000_000;
  const recurring = {
    enabled: true,
    nextRunAt: null,
    trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    runCount: 0,
    lastRunStatus: null,
  } as const;
  expect(statusLabel(recurring, now)).toBe("Not scheduled");
  expect(statusLabel({ ...recurring, enabled: false }, now)).toBe("Paused");
  const once = {
    ...recurring,
    enabled: false,
    trigger: { triggerType: "once", runAt: now - 1 },
  } as const;
  expect(statusLabel(once, now)).toBe("Expired, edit to reschedule");
  expect(
    statusLabel({ ...once, runCount: 1, lastRunStatus: "succeeded" }, now),
  ).toBe("Completed");
  expect(
    statusLabel({ ...once, runCount: 1, lastRunStatus: "failed" }, now),
  ).toBe("Failed");
  expect(canToggle({ ...once, runCount: 1 })).toBe(false);
  expect(canToggle(recurring)).toBe(true);
});

it("prefixes the composer draft with the create prompt once", () => {
  expect(withCreateAutomationPrompt("check CI")).toBe(
    "Create a new bb automation to check CI",
  );
  expect(
    withCreateAutomationPrompt("Create a new bb automation to check CI"),
  ).toBe("Create a new bb automation to check CI");
});
