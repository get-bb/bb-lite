import type { TimelineRow } from "@bb/server-contract";
import {
  buildTimelineRowTitle,
  buildTimelineViewRows,
  findActiveLatestBundleId,
  type ThreadTimelineViewRow,
} from "@bb/thread-view";

interface LogTextOptions {
  verbose: boolean;
  color: boolean;
}

interface LogContext extends LogTextOptions {
  depth: number;
  activeBundleId: string | null;
}

const HEADER_WIDTH = 60;

function indent(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n");
}

function formatRow(row: ThreadTimelineViewRow, context: LogContext): string {
  const dim = (text: string): string =>
    context.color ? `\x1b[2m${text}\x1b[22m` : text;
  const { plain } = buildTimelineRowTitle(row, {
    summaryStyle: "bundle",
    workStyle: "default",
    isActiveLatestBundle: row.id === context.activeBundleId,
  });
  const rule = "─".repeat(Math.max(0, HEADER_WIDTH - plain.length - 4));
  const header = dim(
    context.depth === 0 && rule !== "" ? `── ${plain} ${rule}` : `── ${plain}`,
  );
  const nested = (rows: readonly ThreadTimelineViewRow[]): string =>
    indent(
      formatRows(rows, {
        ...context,
        depth: context.depth + 1,
        activeBundleId: findActiveLatestBundleId(rows),
      }),
    );
  const lines = [header];
  if (row.kind === "conversation") {
    lines.push(row.text);
    if (row.role === "user" && row.turnRequest.kind === "steer") {
      const { status } = row.turnRequest;
      const suffix = { pending: " pending", rejected: " failed" };
      lines.push(`steer${suffix[status as keyof typeof suffix] ?? ""}`);
    }
  } else if (row.kind === "system") {
    if (row.detail) lines.push(dim(indent(row.detail)));
  } else if (row.kind === "turn") {
    if (row.children && row.children.length > 0) {
      lines.push(nested(row.children));
    }
  } else if (row.kind === "work") {
    const output = "output" in row ? row.output.trim() : "";
    if (row.workKind === "command") {
      lines.push(`  $ ${row.command}`);
      if (context.verbose && output !== "") lines.push(dim(indent(output)));
      const exited = row.exitCode !== null && row.status !== "pending";
      if (exited && (row.exitCode !== 0 || output === "")) {
        lines.push(dim(`  exit ${row.exitCode}`));
      }
    } else if (row.workKind === "tool") {
      if (row.approvalStatus !== null) lines.push(`  ${row.approvalStatus}`);
      if (context.verbose && output !== "") lines.push(dim(indent(output)));
    } else if (row.workKind === "file-change") {
      if (row.approvalStatus !== null) lines.push(`  ${row.approvalStatus}`);
      const { diff } = row.change;
      if (context.verbose && diff) lines.push(dim(indent(diff.trimEnd())));
    } else if (row.workKind === "plan-steps" && context.verbose) {
      const marks = { completed: "[x]", active: "[>]", failed: "[!]" };
      for (const { status, step } of row.steps) {
        const mark = marks[status as keyof typeof marks] ?? "[ ]";
        lines.push(dim(`  ${mark} ${step}`));
      }
    } else if (row.workKind === "delegation" && row.childRows.length > 0) {
      lines.push(nested(row.childRows));
    }
  } else if (context.verbose || row.kind === "bundle-summary") {
    if (row.children.length > 0) lines.push(nested(row.children));
  }
  return lines.join("\n");
}

function formatRows(
  rows: readonly ThreadTimelineViewRow[],
  context: LogContext,
): string {
  return rows.map((row) => formatRow(row, context)).join("\n\n");
}

export function formatTimelineText(
  rows: readonly TimelineRow[],
  options: LogTextOptions,
): string {
  const viewRows = buildTimelineViewRows(rows);
  const activeBundleId = findActiveLatestBundleId(viewRows);
  return formatRows(viewRows, { ...options, depth: 0, activeBundleId });
}
