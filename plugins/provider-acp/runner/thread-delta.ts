import type { ThreadEventPlanStep } from "@bb/domain";

export type { DeltaPresentation } from "./kit.js";

export interface DeltaFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  movePath?: string;
  diff?: string;
  oldText?: string;
  newText?: string;
}

export type DeltaItemShape =
  | {
      type: "command";
      command: string;
      cwd: string;
      aggregatedOutput?: string;
      exitCode?: number;
      durationMs?: number;
    }
  | { type: "fileChange"; changes: DeltaFileChange[] }
  | {
      type: "tool";
      tool: string;
      server?: string;
      args?: unknown;
      result?: unknown;
      error?: string;
      durationMs?: number;
    }
  | { type: "compaction" }
  | { type: "agentMessage"; text: string }
  | { type: "reasoning"; summary: string[]; content: string[] }
  | { type: "plan"; text: string }
  | { type: "webSearch"; queries: string[] }
  | {
      type: "webFetch";
      url: string;
      prompt?: string | null;
      pattern: string | null;
    }
  | { type: "fileRead"; path: string; cmd?: string }
  | {
      type: "search";
      mode: "content" | "path" | "list";
      query: string;
      path?: string;
      cmd?: string;
    }
  | {
      type: "delegation";
      childRef: string;
      label: string;
      background: boolean;
      summary?: string;
    }
  | {
      type: "planSteps";
      steps: ThreadEventPlanStep[];
      explanation?: string;
    };
