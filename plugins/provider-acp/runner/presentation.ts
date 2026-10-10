import type { ThreadEventItemPresentation } from "@bb/domain";
import { fileName, presentation } from "@bb/runner";
import type { AcpToolKind } from "./wire.js";

function stripCodeTicks(text: string): string {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function commandPresentation(
  command: string,
): ThreadEventItemPresentation {
  return presentation(
    "Running command",
    "Ran command",
    "Terminal",
    stripCodeTicks(command),
  );
}

export type AcpFileChangeVerb = "add" | "update" | "delete";

export function fileChangePresentation(args: {
  verb: AcpFileChangeVerb;
  paths: readonly string[];
}): ThreadEventItemPresentation {
  const names = [...new Set(args.paths.map(fileName))];
  const plural = names.length > 1;
  const title = names.length === 0 ? undefined : names.join(", ");
  if (args.verb === "add") {
    return plural
      ? presentation("Writing files", "Wrote files", "EditFile", title)
      : presentation("Writing file", "Wrote file", "EditFile", title);
  }
  if (args.verb === "delete") {
    return plural
      ? presentation("Deleting files", "Deleted files", "Trash2", title)
      : presentation("Deleting file", "Deleted file", "Trash2", title);
  }
  return plural
    ? presentation("Editing files", "Edited files", "EditFile", title)
    : presentation("Editing file", "Edited file", "EditFile", title);
}

export function delegationPresentation(args: {
  label: string;
  detail?: string;
}): ThreadEventItemPresentation {
  const base = presentation(
    "Running subagent",
    "Subagent finished",
    "UserRound",
    args.label,
  );
  return args.detail === undefined ? base : { ...base, detail: args.detail };
}

interface KindPresentationSpec {
  label: ThreadEventItemPresentation["label"];
  glyph: string;
}

const KIND_PRESENTATIONS: Readonly<Record<AcpToolKind, KindPresentationSpec>> =
  {
    read: {
      label: { pending: "Reading file", completed: "Read file" },
      glyph: "FileText",
    },
    edit: {
      label: { pending: "Editing file", completed: "Edited file" },
      glyph: "EditFile",
    },
    delete: {
      label: { pending: "Deleting file", completed: "Deleted file" },
      glyph: "Trash2",
    },
    move: {
      label: { pending: "Moving file", completed: "Moved file" },
      glyph: "FolderEdit",
    },
    search: {
      label: { pending: "Searching", completed: "Searched" },
      glyph: "Search",
    },
    execute: {
      label: { pending: "Running command", completed: "Ran command" },
      glyph: "Terminal",
    },
    think: {
      label: { pending: "Thinking", completed: "Thought" },
      glyph: "Brain",
    },
    fetch: {
      label: { pending: "Fetching", completed: "Fetched" },
      glyph: "Globe",
    },
    switch_mode: {
      label: { pending: "Switching mode", completed: "Switched mode" },
      glyph: "SlidersHorizontal",
    },
    other: {
      label: { pending: "Running tool", completed: "Ran tool" },
      glyph: "Toolbox",
    },
  };

export function toolKindPresentation(args: {
  kind: AcpToolKind | undefined;
  name?: string | undefined;
  title: string | undefined;
}): ThreadEventItemPresentation {
  const spec = KIND_PRESENTATIONS[args.kind ?? "other"];
  const label =
    args.name === undefined
      ? spec.label
      : { pending: `Running ${args.name}`, completed: `Ran ${args.name}` };
  return presentation(label.pending, label.completed, spec.glyph, args.title);
}
