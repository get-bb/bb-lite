import { createContext, useContext } from "react";
import type { InlineCode, Nodes, Parent, Text } from "mdast";
import type {} from "mdast-util-to-hast";
import { visit } from "unist-util-visit";
import {
  isRawThreadId,
  RAW_THREAD_ID_PATTERN_SOURCE,
  type PromptTextMention,
} from "@bb/domain";
import {
  PromptMentionPill,
  resolveThreadMentionResource,
} from "../thread/timeline/ConversationMessageMentions";
import {
  isMentionBoundary,
  isMentionEndBoundary,
  isRawThreadIdBoundary,
  isRawThreadIdEndBoundary,
  useRawThreadMentionResource,
  useSidebarThreadMentionResource,
  useThreadMentionResource,
} from "../thread/ThreadTitleMentions";
import type { TimelineTitleLinkResolver } from "../../lib/timeline-title-links";
import { replaceTextMatches } from "./markdown-text-matches";

export interface MarkdownThreadMentions {
  mentions: readonly PromptTextMention[];
  preserveSoftBreaks: boolean;
  resolveLinkHref?: TimelineTitleLinkResolver;
}

export const MarkdownThreadMentionsContext =
  createContext<MarkdownThreadMentions | null>(null);

const THREAD_MENTION_PATTERN = new RegExp(
  `@thread:([A-Za-z0-9_-]+)|(${RAW_THREAD_ID_PATTERN_SOURCE})`,
  "gu",
);
const MAYBE_THREAD_MENTION_PATTERN = new RegExp(
  `@thread|&[#a-z]|${RAW_THREAD_ID_PATTERN_SOURCE}`,
  "iu",
);
const THREAD_MENTION_PREFIX = "@thread";
const THREAD_MENTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

function threadMentionNode(
  threadId: string,
  raw: "text" | "code" | null = null,
): Text {
  return {
    type: "text",
    value: "",
    data: {
      hName: "bb-thread-mention",
      hProperties: {
        dataThreadId: threadId,
        ...(raw === null ? {} : { dataRawThreadId: threadId }),
        ...(raw === "code" ? { dataRawThreadInlineCode: "true" } : {}),
      },
    },
  };
}

interface TextDirectiveNode {
  attributes?: Record<string, unknown> | null;
  children?: unknown[];
  name?: unknown;
  type: string;
}

function collectLinkDescendants(tree: Nodes): WeakSet<object> {
  const linkNodes = new WeakSet<object>();
  visit(tree, (node) => {
    if (node.type === "link" || node.type === "linkReference") {
      visit(node, (descendant) => {
        linkNodes.add(descendant);
      });
    }
  });
  return linkNodes;
}

export function remarkThreadMentions() {
  return (tree: Nodes, file: { value: unknown }): void => {
    if (
      typeof file.value === "string" &&
      !MAYBE_THREAD_MENTION_PATTERN.test(file.value.replaceAll("\\", ""))
    ) {
      return;
    }
    const linkNodes = collectLinkDescendants(tree);
    visit(
      tree,
      "inlineCode",
      (node: InlineCode, index, parent: Parent | undefined) => {
        if (
          parent === undefined ||
          index === undefined ||
          linkNodes.has(node) ||
          !isRawThreadId(node.value)
        ) {
          return;
        }
        parent.children.splice(index, 1, threadMentionNode(node.value, "code"));
        return index + 1;
      },
    );
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (parent === undefined || index === undefined || linkNodes.has(node)) {
        return;
      }
      const { value } = node;
      const replacements = replaceTextMatches(
        node,
        THREAD_MENTION_PATTERN,
        (match) => {
          const end = match.index + match[0].length;
          if (match[1] !== undefined) {
            return isMentionBoundary(value, match.index) &&
              isMentionEndBoundary(value, end)
              ? threadMentionNode(match[1])
              : null;
          }
          return match[2] !== undefined &&
            isRawThreadIdBoundary(value, match.index) &&
            isRawThreadIdEndBoundary(value, end)
            ? threadMentionNode(match[2], "text")
            : null;
        },
      );
      if (replacements.length === 1 && replacements[0] === node) {
        return;
      }
      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
    visit(tree, (node, index, parent: Parent | undefined) => {
      const directive = node as TextDirectiveNode;
      const previous =
        parent === undefined || index === undefined || index === 0
          ? undefined
          : parent.children[index - 1];
      if (
        parent === undefined ||
        index === undefined ||
        directive.type !== "textDirective" ||
        typeof directive.name !== "string" ||
        !THREAD_MENTION_ID_PATTERN.test(directive.name) ||
        directive.children?.length !== 0 ||
        Object.keys(directive.attributes ?? {}).length !== 0 ||
        previous?.type !== "text" ||
        !previous.value.endsWith(THREAD_MENTION_PREFIX)
      ) {
        return;
      }
      const prefixStart = previous.value.length - THREAD_MENTION_PREFIX.length;
      const next = parent.children[index + 1];
      const isMention =
        isMentionBoundary(previous.value, prefixStart) &&
        (next?.type !== "text" || isMentionEndBoundary(next.value, 0)) &&
        !linkNodes.has(node);
      previous.value = previous.value.slice(0, prefixStart);
      parent.children.splice(
        index,
        1,
        isMention
          ? threadMentionNode(directive.name)
          : {
              type: "text",
              value: `${THREAD_MENTION_PREFIX}:${directive.name}`,
            },
      );
      return index + 1;
    });
  };
}

interface ThreadMentionElementProps {
  "data-raw-thread-id"?: string;
  "data-raw-thread-inline-code"?: string;
  "data-thread-id"?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "bb-thread-mention": ThreadMentionElementProps;
    }
  }
}

function RawThreadMentionPill({
  inlineCode,
  threadId,
}: {
  inlineCode: boolean;
  threadId: string;
}) {
  const resource = useRawThreadMentionResource(threadId);
  if (resource === null) {
    return inlineCode ? (
      <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs">
        {threadId}
      </code>
    ) : (
      threadId
    );
  }
  return <PromptMentionPill resource={resource} serializedText={threadId} />;
}

function QueriedThreadMentionPill({
  linkHref,
  mentions,
  threadId,
}: {
  linkHref: string | undefined;
  mentions: readonly PromptTextMention[];
  threadId: string;
}) {
  const resource =
    useThreadMentionResource(threadId) ??
    resolveThreadMentionResource(mentions, threadId);
  return (
    <PromptMentionPill
      resource={resource}
      serializedText={`@thread:${threadId}`}
      linkHref={linkHref}
    />
  );
}

const NO_MENTIONS: readonly PromptTextMention[] = [];

export function ThreadMentionElement(props: ThreadMentionElementProps) {
  const context = useContext(MarkdownThreadMentionsContext);
  const mentions = context?.mentions ?? NO_MENTIONS;
  const threadId = props["data-thread-id"] ?? "";
  const sidebarResource = useSidebarThreadMentionResource(threadId);
  if (threadId.length === 0) {
    return null;
  }
  if (props["data-raw-thread-id"] !== undefined) {
    return (
      <RawThreadMentionPill
        inlineCode={props["data-raw-thread-inline-code"] !== undefined}
        threadId={threadId}
      />
    );
  }
  const linkHref =
    context?.resolveLinkHref?.({ kind: "thread", threadId }) ?? undefined;
  const resource =
    sidebarResource ??
    mentions.find(
      (mention) =>
        mention.resource.kind === "thread" &&
        mention.resource.threadId === threadId,
    )?.resource;
  if (resource === undefined) {
    return (
      <QueriedThreadMentionPill
        linkHref={linkHref}
        mentions={mentions}
        threadId={threadId}
      />
    );
  }
  return (
    <PromptMentionPill
      resource={resource}
      serializedText={`@thread:${threadId}`}
      linkHref={linkHref}
    />
  );
}
