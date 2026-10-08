import { createContext, useContext } from "react";
import type { Nodes, Paragraph, Parent, RootContent } from "mdast";
import type {} from "mdast-util-to-hast";
import type { BbNavigate, PluginMessageDirectiveProps } from "@bb/plugin/app";
import { SKIP, visit } from "unist-util-visit";
import type {} from "remark-parse";
import { directive as directiveSyntax } from "micromark-extension-directive";
import type { Extension } from "micromark-util-types";
import type { Processor } from "unified";
import { PluginSlotMount } from "../../plugins/mount";
import { PluginThreadPanelNavigationProvider } from "../plugin/plugin-thread-panel-navigation";
import {
  resolveMessageDirectives,
  usePluginSlots,
  type PluginSlot,
  type ResolvedMessageDirective,
} from "../../plugins/registry";

export const MESSAGE_DIRECTIVE_MOUNT_LIMIT = 32;

export type MessageDirectiveRegistry = ReadonlyMap<
  string,
  ResolvedMessageDirective
>;

export interface MountedMessageDirective {
  attributes: Readonly<Record<string, string>>;
  index: number;
  slot: PluginSlot<"messageDirectives">;
  source: string;
}

export type MarkdownMessageDirectiveOpenThreadPanel = (
  options: Parameters<BbNavigate["openThreadPanel"]>[0] & {
    pluginId: string;
  },
) => boolean;

export interface MarkdownMessageDirectives {
  registry: MessageDirectiveRegistry;
  message: PluginMessageDirectiveProps["message"];
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
  openThreadPanel: MarkdownMessageDirectiveOpenThreadPanel | null;
}

interface DirectiveNode {
  type: "textDirective" | "leafDirective";
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  position?: {
    start?: { offset?: number | undefined };
    end?: { offset?: number | undefined };
  };
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "bb-message-directive": { "data-directive-index"?: string };
    }
  }
}

const registryBySlots = new WeakMap<
  readonly PluginSlot<"messageDirectives">[],
  MessageDirectiveRegistry
>();

export function useMessageDirectiveRegistry(): MessageDirectiveRegistry {
  const slots = usePluginSlots().messageDirectives;
  let registry = registryBySlots.get(slots);
  if (registry === undefined) {
    registry = resolveMessageDirectives(slots);
    for (const [id, directive] of registry) {
      if (directive.status === "collision") {
        console.warn(
          `[plugin] message directive "${id}" claimed by multiple plugins (${directive.pluginIds.join(", ")}); rendering as literal text`,
        );
      }
    }
    registryBySlots.set(slots, registry);
  }
  return registry;
}

function directiveAttributes(node: DirectiveNode): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    if (typeof value === "string") {
      attributes[key] = value;
    }
  }
  return attributes;
}

function directiveSource(
  node: DirectiveNode,
  markdownSource: string,
  attributes: Readonly<Record<string, string>>,
  marker: string,
): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start !== undefined && end !== undefined && end >= start) {
    return markdownSource.slice(start, end);
  }
  const body = Object.keys(attributes)
    .map((key) => `${key}=${JSON.stringify(attributes[key])}`)
    .join(" ");
  return `${marker}${node.name ?? ""}${body.length === 0 ? "" : `{${body}}`}`;
}

function spliceLiteralDirective(
  parent: Parent,
  index: number,
  type: DirectiveNode["type"],
  source: string,
): number {
  if (type !== "textDirective") {
    parent.children.splice(index, 1, {
      type: "paragraph",
      children: [{ type: "text", value: source }],
    });
    return index;
  }
  const previous = parent.children[index - 1];
  const next = parent.children[index + 1];
  if (previous?.type === "text") {
    previous.value += source;
    previous.position = undefined;
    if (next?.type === "text") {
      previous.value += next.value;
      parent.children.splice(index, 2);
    } else {
      parent.children.splice(index, 1);
    }
  } else if (next?.type === "text") {
    next.value = `${source}${next.value}`;
    next.position = undefined;
    parent.children.splice(index, 1);
  } else {
    parent.children.splice(index, 1, { type: "text", value: source });
  }
  return index;
}

function asDirectiveNode(node: unknown): DirectiveNode | null {
  const type = (node as { type?: unknown } | null | undefined)?.type;
  return type === "textDirective" || type === "leafDirective"
    ? (node as DirectiveNode)
    : null;
}

function gluedDirectiveSyntax(registry: MessageDirectiveRegistry): Extension {
  const constructs = directiveSyntax().text?.[58];
  const textDirective = Array.isArray(constructs) ? constructs[0] : constructs;
  if (textDirective === undefined) {
    throw new Error("Directive text tokenizer is unavailable");
  }
  return {
    text: {
      58: {
        previous: (code) => code === null,
        tokenize(effects, ok, nok) {
          const eventStart = this.events.length;
          const startLine = this.now().line;
          const start = textDirective.tokenize.call(
            this,
            effects,
            (code) => {
              let name = "";
              let hasAttributes = false;
              for (let i = eventStart; i < this.events.length; i += 1) {
                const [kind, token] = this.events[i]!;
                if (kind !== "exit") continue;
                if (token.type === "directiveTextName") {
                  name = this.sliceSerialize(token);
                } else if (token.type === "directiveTextAttributes") {
                  hasAttributes =
                    token.start.line === startLine &&
                    token.end.line === startLine;
                }
              }
              return hasAttributes && registry.get(name)?.status === "ok"
                ? ok(code)
                : nok(code);
            },
            nok,
          );
          return (code) => {
            const afterMarker = start(code);
            return (secondColon) => {
              if (secondColon !== 58 || afterMarker === undefined) {
                return nok(secondColon);
              }
              effects.enter("directiveTextMarker");
              effects.consume(secondColon);
              effects.exit("directiveTextMarker");
              return afterMarker;
            };
          };
        },
      },
    },
  };
}

export function remarkMessageDirectives(
  this: Processor,
  args: {
    indexBase: number;
    limit: number;
    mounts: MountedMessageDirective[];
    registry: MessageDirectiveRegistry;
  },
) {
  const { indexBase, limit, mounts, registry } = args;
  const data = this.data();
  const extensions =
    data.micromarkExtensions ?? (data.micromarkExtensions = []);
  extensions.push(gluedDirectiveSyntax(registry));
  return (tree: Nodes, file: { value: unknown }): void => {
    const markdownSource =
      typeof file.value === "string" ? file.value : String(file.value ?? "");
    mounts.length = 0;
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (parent === undefined || index === undefined) return;
      const paragraph = node.type === "paragraph" ? node : null;
      const leadingDirective = asDirectiveNode(paragraph?.children[0]);
      const isGlued =
        leadingDirective?.type === "textDirective" &&
        markdownSource.startsWith(
          "::",
          leadingDirective.position?.start?.offset ?? -1,
        );
      const directive = isGlued ? leadingDirective : asDirectiveNode(node);
      if (directive === null) return;
      const name = directive.name ?? "";
      const attributes = directiveAttributes(directive);
      const source = directiveSource(
        directive,
        markdownSource,
        attributes,
        isGlued || directive.type === "leafDirective" ? "::" : ":",
      );
      const entry = registry.get(name);
      if (
        (!isGlued && directive.type !== "leafDirective") ||
        entry?.status !== "ok" ||
        mounts.length >= limit
      ) {
        if (isGlued) return;
        return spliceLiteralDirective(parent, index, directive.type, source);
      }
      const mountIndex = indexBase + mounts.length;
      mounts.push({ attributes, index: mountIndex, slot: entry.slot, source });
      const remainder: Paragraph | null =
        isGlued && paragraph !== null && paragraph.children.length > 1
          ? { ...paragraph, children: paragraph.children.slice(1) }
          : null;
      const mountNode: RootContent = {
        type: "paragraph",
        children: [],
        data: {
          hName: "bb-message-directive",
          hProperties: { dataDirectiveIndex: mountIndex },
        },
      };
      parent.children.splice(
        index,
        1,
        mountNode,
        ...(remainder === null ? [] : [remainder]),
      );
      return [SKIP, index];
    });
  };
}

export const EMPTY_MOUNTED_MESSAGE_DIRECTIVES: readonly MountedMessageDirective[] =
  [];

export const MessageDirectiveMountsContext = createContext<{
  directives: MarkdownMessageDirectives;
  mounts: readonly MountedMessageDirective[];
} | null>(null);

export function MessageDirectiveElement(props: {
  "data-directive-index"?: string;
}) {
  const context = useContext(MessageDirectiveMountsContext);
  const mount = context?.mounts[Number(props["data-directive-index"])];
  if (context === null || mount === undefined) {
    return null;
  }
  const { slot, attributes, source } = mount;
  const { message, openThreadPanel, openWorkspaceFile } = context.directives;
  const Component = slot.component;
  const element = (
    <Component
      attributes={attributes}
      source={source}
      message={message}
      openWorkspaceFile={openWorkspaceFile}
    />
  );
  return (
    <PluginSlotMount
      key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
      pluginId={slot.pluginId}
      slotKind="messageDirective"
      slotId={slot.id}
      crashFallback={source}
    >
      {openThreadPanel === null ? (
        element
      ) : (
        <PluginThreadPanelNavigationProvider openThreadPanel={openThreadPanel}>
          {element}
        </PluginThreadPanelNavigationProvider>
      )}
    </PluginSlotMount>
  );
}
