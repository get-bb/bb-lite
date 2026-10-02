import { z } from "zod";
import type { PromptDraftAttachment } from "@bb/client-core";

export type ComposerMention = {
  from: number;
  to: number;
  label: string;
} & (
  | { kind: "thread"; threadId: string; projectId?: string }
  | { kind: "project"; projectId: string }
  | { kind: "section"; sectionId: string }
  | {
      kind: "path";
      path: string;
      source: "workspace" | "thread-storage";
      entryKind: "file" | "directory";
    }
  | {
      kind: "command";
      trigger: "/" | "$";
      name: string;
      source: "skill" | "command";
      origin: "builtin" | "project" | "user";
      argumentHint: string | null;
    }
  | {
      kind: "plugin";
      pluginId: string;
      provider: string;
      id: string;
      icon?: string | null;
    }
);

interface ComposerDraft {
  text: string;
  mentions: readonly ComposerMention[];
}

export interface ComposerDraftSnapshot extends ComposerDraft {
  readonly attachments: readonly PromptDraftAttachment[];
}

export interface ComposerDraftReplacement extends ComposerDraft {
  attachments?: readonly PromptDraftAttachment[];
}

const range = {
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  label: z.string(),
};
const mentionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...range,
    kind: z.literal("thread"),
    threadId: z.string(),
    projectId: z.string().optional(),
  }),
  z.object({ ...range, kind: z.literal("project"), projectId: z.string() }),
  z.object({ ...range, kind: z.literal("section"), sectionId: z.string() }),
  z.object({
    ...range,
    kind: z.literal("path"),
    path: z.string(),
    source: z.enum(["workspace", "thread-storage"]),
    entryKind: z.enum(["file", "directory"]),
  }),
  z.object({
    ...range,
    kind: z.literal("command"),
    trigger: z.enum(["/", "$"]),
    name: z.string(),
    source: z.enum(["skill", "command"]),
    origin: z.enum(["builtin", "project", "user"]),
    argumentHint: z.string().nullable(),
  }),
  z.object({
    ...range,
    kind: z.literal("plugin"),
    pluginId: z.string(),
    provider: z
      .string()
      .min(1)
      .refine((value) => !value.includes(":")),
    id: z.string(),
    icon: z.string().nullable().optional(),
  }),
]);
const attachmentsSchema = z.array(
  z.object({
    type: z.enum(["localImage", "localFile"]),
    path: z.string().min(1),
    name: z.string(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().nonnegative(),
  }),
);
const replacementSchema = z
  .object({
    text: z.string(),
    mentions: z.array(mentionSchema),
    attachments: attachmentsSchema.optional(),
  })
  .superRefine((draft, context) => {
    let end = 0;
    for (const mention of [...draft.mentions].sort((a, b) => a.from - b.from)) {
      if (
        mention.from < end ||
        mention.to <= mention.from ||
        mention.to > draft.text.length
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Mention ranges must be non-overlapping and inside the draft text.",
        });
      }
      end = mention.to;
    }
  });

interface DraftTarget {
  getDraft(): ComposerDraftSnapshot;
  setDraft(next: ComposerDraftReplacement): void;
  isAvailable(): boolean;
  focus(): void;
}

interface ComposerDraftActions {
  readonly draft: ComposerDraftSnapshot;
  replace(
    next:
      | ComposerDraftReplacement
      | ((current: ComposerDraftSnapshot) => ComposerDraftReplacement),
  ): void;
  focus(): void;
}

export function createComposerDraftActions(
  target: () => DraftTarget,
): ComposerDraftActions {
  let cached: {
    content: ComposerDraftSnapshot;
    snapshot: ComposerDraftSnapshot;
  } | null = null;
  const snapshotOf = (current: DraftTarget): ComposerDraftSnapshot => {
    const content = current.getDraft();
    if (cached?.content === content) return cached.snapshot;
    const snapshot = Object.freeze({
      text: content.text,
      mentions: Object.freeze(
        content.mentions.map((mention) => Object.freeze({ ...mention })),
      ),
      attachments: Object.freeze(
        content.attachments.map((attachment) =>
          Object.freeze({ ...attachment }),
        ),
      ),
    });
    cached = { content, snapshot };
    return snapshot;
  };
  const requireAvailable = (current: DraftTarget) => {
    if (!current.isAvailable())
      throw new Error("This composer is no longer available.");
  };
  return {
    get draft() {
      return snapshotOf(target());
    },
    replace(next) {
      const current = target();
      requireAvailable(current);
      const snapshot = snapshotOf(current);
      const result = typeof next === "function" ? next(snapshot) : next;
      requireAvailable(current);
      if (result === snapshot) return;
      const parsed = replacementSchema.safeParse(result);
      if (!parsed.success)
        throw new Error(
          "Invalid composer draft: text, mention ranges, or attachments are invalid.",
        );
      current.setDraft(parsed.data);
    },
    focus() {
      const current = target();
      requireAvailable(current);
      current.focus();
    },
  };
}
