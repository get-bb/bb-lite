import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Code, Root } from "mdast";
import type {} from "mdast-util-to-hast";
import {
  threadView,
  type CodeFenceProps,
  type CodeFenceRenderer,
  type CodeFenceStatus,
} from "@bb/plugin/app";
import { visit } from "unist-util-visit";
import { PluginSlotMount } from "../../plugins/mount";
import { resolveCodeFenceRenderers, type Owned } from "../../plugins/registry";
import { useOwned } from "../../plugins/slots";
import { PluginThreadPanelNavigationProvider } from "../plugin/plugin-thread-panel-navigation";
import type { MarkdownMessageDirectiveOpenThreadPanel } from "./markdown-message-directives";
import {
  closesAnyIndentMarkdownFence,
  parseMarkdownFenceStart,
} from "./markdown-prompt-blockquote-boundaries";

const CODE_FENCE_OFFSET_PROPERTY = "dataCodeFenceOffset";
const CODE_FENCE_CLOSED_PROPERTY = "dataCodeFenceClosed";
const MARKDOWN_CONTAINER_PREFIX_PATTERN = /^[ \t>]*/u;

export type CodeFenceRendererRegistry = ReadonlyMap<
  string,
  Owned<CodeFenceRenderer>
>;

export interface CodeFenceElementProps {
  "data-code-fence-offset"?: string;
  "data-code-fence-closed"?: string;
}

export function buildCodeFenceRendererRegistry(
  slots: readonly Owned<CodeFenceRenderer>[],
  options?: { warn?: (message: string) => void },
): CodeFenceRendererRegistry {
  const warn = options?.warn ?? ((message: string) => console.warn(message));
  const registry = new Map<string, Owned<CodeFenceRenderer>>();
  for (const [language, resolved] of resolveCodeFenceRenderers(slots)) {
    if (resolved.status === "collision") {
      warn(
        `[plugin] code fence language "${language}" claimed by multiple plugins (${resolved.pluginIds.join(", ")}); rendering bb's code block`,
      );
      continue;
    }
    registry.set(language, resolved.slot);
  }
  return registry;
}

const registryBySlots = new WeakMap<
  readonly Owned<CodeFenceRenderer>[],
  CodeFenceRendererRegistry
>();

export function useCodeFenceRendererRegistry(): CodeFenceRendererRegistry | null {
  const slots = useOwned(threadView.codeFence);
  let registry = registryBySlots.get(slots);
  if (registry === undefined) {
    registry = buildCodeFenceRendererRegistry(slots);
    registryBySlots.set(slots, registry);
  }
  return registry.size === 0 ? null : registry;
}

function isClosedCodeFence(node: Code, markdownSource: string): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    return false;
  }
  const lines = markdownSource.slice(start, end).split("\n");
  const fence = parseMarkdownFenceStart(lines[0] ?? "");
  const closingLine = lines.at(-1);
  if (fence === null || lines.length < 2 || closingLine === undefined) {
    return false;
  }
  return (
    closesAnyIndentMarkdownFence(
      closingLine.replace(MARKDOWN_CONTAINER_PREFIX_PATTERN, ""),
      fence,
    ) &&
    (node.value === "" || node.value.split("\n").length === lines.length - 2)
  );
}

export function remarkCodeFenceRenderers(args: {
  registry: CodeFenceRendererRegistry;
  sourceOffset: number;
}) {
  const { registry, sourceOffset } = args;
  return (tree: Root, file: { value: unknown }): void => {
    const markdownSource =
      typeof file.value === "string" ? file.value : String(file.value ?? "");
    visit(tree, "code", (node) => {
      const language = node.lang?.toLowerCase();
      const offset = node.position?.start.offset;
      if (
        language === undefined ||
        offset === undefined ||
        !registry.has(language)
      ) {
        return;
      }
      node.data ??= {};
      node.data.hProperties = {
        ...node.data.hProperties,
        [CODE_FENCE_OFFSET_PROPERTY]: String(sourceOffset + offset),
        [CODE_FENCE_CLOSED_PROPERTY]: String(
          isClosedCodeFence(node, markdownSource),
        ),
      };
    });
  };
}

interface CodeFenceBlock {
  closed: boolean;
  code: string;
  language: string;
  original: ReactNode;
}

interface CodeFenceEntry {
  block: CodeFenceBlock | null;
  container: HTMLDivElement;
  offset: number;
  placeholder: HTMLElement | null;
}

interface CodeFenceHost {
  registry: CodeFenceRendererRegistry;
  attach: (offset: number, placeholder: HTMLElement) => void;
  detach: (offset: number, placeholder: HTMLElement) => void;
  update: (offset: number, block: CodeFenceBlock) => void;
}

const CodeFenceHostContext = createContext<CodeFenceHost | null>(null);

const CodeFenceOriginalContext = createContext<ReactNode>(null);

function CodeFenceOriginal() {
  return <>{useContext(CodeFenceOriginalContext)}</>;
}

function placeCodeFenceContainer(
  parent: HTMLElement,
  container: HTMLDivElement,
): void {
  if (container.parentNode === parent) {
    return;
  }
  if (
    container.isConnected &&
    parent.isConnected &&
    typeof parent.moveBefore === "function"
  ) {
    try {
      parent.moveBefore(container, null);
      return;
    } catch {
      parent.appendChild(container);
      return;
    }
  }
  parent.appendChild(container);
}

export function useCodeFenceLanguages(): CodeFenceRendererRegistry | null {
  return useContext(CodeFenceHostContext)?.registry ?? null;
}

interface CodeFenceRendererHostProps {
  children: ReactNode;
  message: CodeFenceProps["message"];
  openThreadPanel: MarkdownMessageDirectiveOpenThreadPanel | null;
  registry: CodeFenceRendererRegistry;
  streaming: boolean;
}

export function CodeFenceRendererHost({
  children,
  message,
  openThreadPanel,
  registry,
  streaming,
}: CodeFenceRendererHostProps) {
  const [entries] = useState(() => new Map<number, CodeFenceEntry>());
  const parkingRef = useRef<HTMLDivElement>(null);
  const [, rerender] = useReducer((revision: number) => revision + 1, 0);

  const host = useMemo(
    (): CodeFenceHost => ({
      registry,
      attach(offset, placeholder) {
        let entry = entries.get(offset);
        if (entry === undefined) {
          entry = {
            block: null,
            container: document.createElement("div"),
            offset,
            placeholder,
          };
          entries.set(offset, entry);
        } else {
          entry.placeholder = placeholder;
        }
        placeCodeFenceContainer(placeholder, entry.container);
      },
      detach(offset, placeholder) {
        const entry = entries.get(offset);
        if (entry === undefined || entry.placeholder !== placeholder) {
          return;
        }
        entry.placeholder = null;
        if (parkingRef.current !== null) {
          placeCodeFenceContainer(parkingRef.current, entry.container);
        }
        queueMicrotask(() => {
          if (entry.placeholder !== null || entries.get(offset) !== entry) {
            return;
          }
          entry.container.remove();
          entries.delete(offset);
          rerender();
        });
      },
      update(offset, block) {
        const entry = entries.get(offset);
        if (entry === undefined) {
          return;
        }
        const previous = entry.block;
        entry.block = block;
        if (
          previous === null ||
          previous.code !== block.code ||
          previous.closed !== block.closed ||
          previous.language !== block.language
        ) {
          rerender();
        }
      },
    }),
    [entries, registry],
  );

  const ordered = [...entries.values()].sort(
    (left, right) => left.offset - right.offset,
  );
  const ordinals = new Map<string, number>();
  const mounts: ReactNode[] = [];
  for (const entry of ordered) {
    const { block } = entry;
    if (block === null) {
      continue;
    }
    const index = ordinals.get(block.language) ?? 0;
    ordinals.set(block.language, index + 1);
    const slot = registry.get(block.language);
    mounts.push(
      createPortal(
        <CodeFenceOriginalContext.Provider value={block.original}>
          {slot === undefined ? (
            <CodeFenceOriginal />
          ) : (
            <CodeFenceMount
              code={block.code}
              index={index}
              language={block.language}
              message={message}
              openThreadPanel={openThreadPanel}
              slot={slot}
              status={
                block.closed ? "closed" : streaming ? "streaming" : "unclosed"
              }
            />
          )}
        </CodeFenceOriginalContext.Provider>,
        entry.container,
        String(entry.offset),
      ),
    );
  }

  return (
    <CodeFenceHostContext.Provider value={host}>
      {children}
      {mounts.length === 0 ? null : (
        <div ref={parkingRef} hidden data-code-fence-parking="" />
      )}
      {mounts}
    </CodeFenceHostContext.Provider>
  );
}

interface CodeFenceMountProps {
  code: string;
  index: number;
  language: string;
  message: CodeFenceProps["message"];
  openThreadPanel: MarkdownMessageDirectiveOpenThreadPanel | null;
  slot: Owned<CodeFenceRenderer>;
  status: CodeFenceStatus;
}

const CodeFenceMount = memo(function CodeFenceMount({
  code,
  index,
  language,
  message,
  openThreadPanel,
  slot,
  status,
}: CodeFenceMountProps) {
  const View = slot.view;
  const element = (
    <View
      code={code}
      language={language}
      status={status}
      index={index}
      message={message}
      Original={CodeFenceOriginal}
    />
  );
  return (
    <PluginSlotMount
      key={`${slot.pluginId}/${slot.id}`}
      pluginId={slot.pluginId}
      slotKind="codeFence"
      slotId={slot.id}
      instanceId={`${message.id}#${language}#${index}`}
      crashResetKey={`${status}\n${code}`}
      crashFallback={<CodeFenceOriginal />}
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
});

interface CodeFencePlaceholderProps {
  closed: boolean;
  code: string;
  language: string;
  offset: number;
  original: ReactNode;
}

export function CodeFencePlaceholder({
  closed,
  code,
  language,
  offset,
  original,
}: CodeFencePlaceholderProps) {
  const host = useContext(CodeFenceHostContext);
  const elementRef = useRef<HTMLDivElement>(null);
  const claimed = host !== null && host.registry.has(language);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (host === null || !claimed || element === null) {
      return;
    }
    host.attach(offset, element);
    return () => {
      host.detach(offset, element);
    };
  }, [host, claimed, offset]);

  useLayoutEffect(() => {
    if (host !== null && claimed) {
      host.update(offset, { closed, code, language, original });
    }
  });

  if (!claimed) {
    return original;
  }
  return <div ref={elementRef} data-code-fence-placeholder="" />;
}
