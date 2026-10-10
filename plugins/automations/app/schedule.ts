import type { Automation, Trigger } from "../contract.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const RUN_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const isNumber = (field: string) => /^\d+$/.test(field);

function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `${h}${suffix}`
    : `${h}:${String(minute).padStart(2, "0")}${suffix}`;
}

function dayName(field: string): string | null {
  if (!isNumber(field)) return null;
  return DAYS[Number(field) % 7] ?? null;
}

function describeDays(field: string): string | null {
  if (field === "*") return "Daily";
  if (field === "1-5") return "Weekdays";
  if (field === "0,6" || field === "6,0") return "Weekends";
  const parts = field.split(",").map((part) => {
    const [from, to, extra] = part.split("-");
    if (extra !== undefined || from === undefined) return null;
    const start = dayName(from);
    if (to === undefined) return start;
    const end = dayName(to);
    return start && end ? `${start}-${end}` : null;
  });
  if (parts.some((part) => part === null)) return null;
  return parts.join(", ");
}

function times(minute: string, hour: string): string | null {
  if (!isNumber(minute)) return null;
  const hours = hour.split(",");
  if (!hours.every(isNumber)) return null;
  return hours.map((h) => clock(Number(h), Number(minute))).join(", ");
}

export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "Custom schedule";
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== "*") return "Custom schedule";
  if (dom === "*" && dow === "*" && hour === "*") {
    if (minute === "*") return "Every minute";
    const every = /^\*\/(\d+)$/.exec(minute);
    if (every) return `Every ${every[1]} min`;
    if (isNumber(minute)) return `Hourly at :${minute.padStart(2, "0")}`;
    return "Custom schedule";
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours && dom === "*" && dow === "*" && isNumber(minute)) {
    return `Every ${everyHours[1]} hours at :${minute.padStart(2, "0")}`;
  }
  const at = times(minute, hour);
  if (at === null) return "Custom schedule";
  if (dom === "*") {
    const days = describeDays(dow);
    return days === null ? "Custom schedule" : `${days} at ${at}`;
  }
  if (dow === "*" && isNumber(dom)) return `Monthly on day ${dom} at ${at}`;
  return "Custom schedule";
}

export function formatRunTime(timestamp: number): string {
  return RUN_TIME.format(new Date(timestamp));
}

export function describeTrigger(trigger: Trigger): string {
  return trigger.triggerType === "once"
    ? `Once on ${formatRunTime(trigger.runAt)}`
    : describeCron(trigger.cron);
}

type StatusFields = Pick<
  Automation,
  "enabled" | "nextRunAt" | "trigger" | "runCount" | "lastRunStatus"
>;

export function statusLabel(
  automation: StatusFields,
  now = Date.now(),
): string {
  const { trigger, enabled, runCount, lastRunStatus, nextRunAt } = automation;
  if (trigger.triggerType === "once" && !enabled) {
    if (runCount > 0) {
      if (lastRunStatus === "running") return "Running";
      if (lastRunStatus === "failed") return "Failed";
      if (lastRunStatus === "skipped") return "Skipped";
      return "Completed";
    }
    if (trigger.runAt <= now) return "Expired, edit to reschedule";
  }
  if (!enabled) return "Paused";
  if (nextRunAt === null) return "Not scheduled";
  return `Next ${formatRunTime(nextRunAt)}`;
}

export function canToggle(automation: StatusFields): boolean {
  if (automation.trigger.triggerType !== "once" || automation.enabled) {
    return true;
  }
  return automation.runCount === 0 && automation.trigger.runAt > Date.now();
}

export const CREATE_AUTOMATION_PROMPT = "Create a new bb automation to ";

export function withCreateAutomationPrompt(text: string): string {
  const rest = text.trimStart();
  const body = rest.startsWith(CREATE_AUTOMATION_PROMPT)
    ? rest.slice(CREATE_AUTOMATION_PROMPT.length)
    : rest;
  return `${CREATE_AUTOMATION_PROMPT}${body}`;
}

export function editAutomationPrompt(automation: Automation): string {
  return `Edit the bb automation ${JSON.stringify(automation.name)} (ID ${automation.id}) in project ${automation.projectId}. I want to `;
}
