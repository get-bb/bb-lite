// @vitest-environment jsdom
import {
  act,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  threadView,
  type CodeFenceProps,
  type CodeFenceRenderer,
} from "@bb/plugin/app";
import {
  buildCodeFenceRendererRegistry,
  CodeFenceRendererHost,
} from "@bb/app-kit/components/ui/markdown-code-fence-renderers";
import { MarkdownPreview } from "@bb/app-kit/components/ui/markdown-preview";
import {
  registerPluginApp,
  resetPluginRegistryForTest,
  type Owned,
} from "@bb/app-kit/plugins/registry";
import { AssistantConversationMessage } from "../../../plugins/thread-view/app/components/thread/timeline/ConversationMessageContent";
import {
  TimelineContext,
  type TimelineContextValue,
} from "../../../plugins/thread-view/app/components/thread/timeline/timeline-context";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MESSAGE = {
  id: "msg_1",
  threadId: "thr_1",
  turnId: "turn_1",
  projectId: "proj_1",
} as const;

const TIMELINE: TimelineContextValue = {
  latestActionableAssistantMessageId: null,
  latestActionableUserMessageId: null,
  liveExpandedRowIds: new Set(),
  projectId: "proj_a",
  resolveSegmentLinkHref: () => null,
  rowDetailViews: new Map(),
  rowViews: new Map(),
  senderThreads: new Map(),
  streamingMessageId: null,
  terminalExpandedRowIds: new Set(),
  threadId: "thr_a",
  workspaceRootPath: undefined,
};

function UiFence(props: CodeFenceProps) {
  return (
    <div
      data-testid="ui-fence"
      data-code={props.code}
      data-language={props.language}
      data-index={String(props.index)}
      data-status={props.status}
      data-message-id={props.message.id}
      data-thread-id={props.message.threadId}
      data-turn-id={props.message.turnId ?? ""}
      data-project-id={props.message.projectId ?? ""}
    />
  );
}

function slot(
  view: ComponentType<CodeFenceProps>,
  overrides: Partial<Owned<CodeFenceRenderer>> = {},
): Owned<CodeFenceRenderer> {
  return {
    id: "generative-ui",
    pluginId: "demo",
    languages: ["ui"],
    view,
    ...overrides,
  };
}

function claim(
  pluginId: string,
  view: ComponentType<CodeFenceProps>,
  languages: readonly string[] = ["ui"],
): void {
  const refused = registerPluginApp(pluginId, (bb) => {
    bb.add(threadView.codeFence, { id: `${pluginId}-ui`, languages, view });
  });
  expect(refused).toBeNull();
}

let container: HTMLDivElement;
let root: Root;

async function show(element: ReactNode): Promise<void> {
  await act(async () => root.render(element));
}

function all(testId: string): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  ];
}

function only(testId: string): HTMLElement {
  const [found, ...rest] = all(testId);
  if (found === undefined || rest.length > 0) {
    throw new Error(`expected one ${testId}, found ${rest.length + 1}`);
  }
  return found;
}

function renderedFences() {
  return all("ui-fence").map((node) => ({
    code: node.getAttribute("data-code"),
    status: node.getAttribute("data-status"),
    index: node.getAttribute("data-index"),
  }));
}

function wrapButtons(scope: ParentNode = container): number {
  return scope.querySelectorAll('button[aria-label="Wrap long lines"]').length;
}

function assistantMessage(text: string, streaming = false) {
  return (
    <TimelineContext.Provider value={TIMELINE}>
      <AssistantConversationMessage
        attachments={null}
        id="msg_a"
        threadId="thr_a"
        turnId="turn_a"
        streaming={streaming}
        showActions={false}
        text={text}
      />
    </TimelineContext.Provider>
  );
}

function hostedMarkdown(
  slots: readonly Owned<CodeFenceRenderer>[],
  content: string,
  streaming = false,
) {
  return (
    <CodeFenceRendererHost
      registry={buildCodeFenceRendererRegistry(slots)}
      message={MESSAGE}
      openThreadPanel={null}
      streaming={streaming}
    >
      <MarkdownPreview content={content} />
    </CodeFenceRendererHost>
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetPluginRegistryForTest();
  vi.restoreAllMocks();
});

describe("code fence renderers in assistant messages", () => {
  it("renders claimed fences with code, language, per-language index, status, and message", async () => {
    claim("demo", UiFence);
    await show(
      assistantMessage(
        [
          "Intro",
          "",
          "```ui",
          "{ first }",
          "```",
          "",
          "```ts",
          "const between = 1;",
          "```",
          "",
          "```UI extra-meta",
          "{ second }",
          "```",
        ].join("\n"),
      ),
    );

    expect(renderedFences()).toEqual([
      { code: "{ first }", status: "closed", index: "0" },
      { code: "{ second }", status: "closed", index: "1" },
    ]);
    const [first] = all("ui-fence");
    expect(first?.getAttribute("data-language")).toBe("ui");
    expect(first?.getAttribute("data-message-id")).toBe("msg_a");
    expect(first?.getAttribute("data-thread-id")).toBe("thr_a");
    expect(first?.getAttribute("data-turn-id")).toBe("turn_a");
    expect(first?.getAttribute("data-project-id")).toBe("proj_a");
    expect(container.textContent).toContain("const between = 1;");
    expect(wrapButtons()).toBe(1);
  });

  it("renders claimed fences in document order between the surrounding prose", async () => {
    claim("demo", UiFence);
    await show(assistantMessage("Before\n\n```ui\n{ a }\n```\n\nAfter"));
    const fence = only("ui-fence");
    const paragraphs = [...container.querySelectorAll("p")];
    const before = paragraphs.find((node) => node.textContent === "Before");
    const after = paragraphs.find((node) => node.textContent === "After");
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(
      before!.compareDocumentPosition(fence) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      fence.compareDocumentPosition(after!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps one component instance and its state from the first streamed line until the reply has finished", async () => {
    let mounts = 0;
    function StatefulFence(props: CodeFenceProps) {
      const [clicks, setClicks] = useState(0);
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <button
          type="button"
          data-testid="stateful-fence"
          data-code={props.code}
          data-status={props.status}
          data-index={String(props.index)}
          onClick={() => setClicks((value) => value + 1)}
        >
          clicks {clicks}
        </button>
      );
    }
    claim("demo", StatefulFence);
    const steps: readonly (readonly [string, string, string])[] = [
      ["Intro\n\n```ui\n{ par", "{ par", "streaming"],
      ["Intro\n\n```ui\n{ partial }\n", "{ partial }", "streaming"],
      ["Intro\n\n```ui\n{ partial }\n```\n", "{ partial }", "closed"],
      [
        "Intro\n\n```ui\n{ partial }\n```\n\nLater prose.\n\nMore pro",
        "{ partial }",
        "closed",
      ],
    ];
    await show(assistantMessage(steps[0]![0], true));
    await act(async () => only("stateful-fence").click());
    for (const [text, code, status] of steps) {
      await show(assistantMessage(text, true));
      const fence = only("stateful-fence");
      expect(fence.getAttribute("data-code")).toBe(code);
      expect(fence.getAttribute("data-status")).toBe(status);
      expect(fence.getAttribute("data-index")).toBe("0");
      expect(fence.textContent).toBe("clicks 1");
    }
    const previews = container.querySelectorAll("[data-markdown-preview]");
    expect(previews).toHaveLength(2);
    expect(previews[0]?.contains(only("stateful-fence"))).toBe(true);

    await show(
      assistantMessage(
        "Intro\n\n```ui\n{ partial }\n```\n\nLater prose.\n\nMore prose.",
        false,
      ),
    );
    const settled = only("stateful-fence");
    expect(settled.textContent).toBe("clicks 1");
    expect(settled.getAttribute("data-status")).toBe("closed");
    expect(container.textContent).toContain("More prose.");
    expect(mounts).toBe(1);
  });

  it("numbers fences across the settled and streaming regions of one reply", async () => {
    claim("demo", UiFence);
    await show(
      assistantMessage(
        "```ui\n{ settled }\n```\n\nMiddle prose.\n\n```ui\n{ tail",
        true,
      ),
    );
    expect(container.querySelectorAll("[data-markdown-preview]")).toHaveLength(
      2,
    );
    expect(renderedFences()).toEqual([
      { code: "{ settled }", status: "closed", index: "0" },
      { code: "{ tail", status: "streaming", index: "1" },
    ]);
  });

  it("reports a fence the reply never closed as unclosed once streaming stops", async () => {
    claim("demo", UiFence);
    await show(assistantMessage("```ui\n{ cut", true));
    expect(renderedFences()).toEqual([
      { code: "{ cut", status: "streaming", index: "0" },
    ]);
    await show(assistantMessage("```ui\n{ cut", false));
    expect(renderedFences()).toEqual([
      { code: "{ cut", status: "unclosed", index: "0" },
    ]);
  });

  it("removes a fence's component when the fence leaves the message", async () => {
    claim("demo", UiFence);
    await show(assistantMessage("```ui\n{ gone }\n```"));
    expect(all("ui-fence")).toHaveLength(1);
    await show(assistantMessage("Plain prose only."));
    expect(all("ui-fence")).toHaveLength(0);
    expect(container.querySelector("[data-code-fence-parking]")).toBeNull();
  });

  it("keeps claimed fences through the sanitized HTML pipeline", async () => {
    claim("demo", UiFence);
    await show(
      assistantMessage(
        "<details><summary>More</summary>hidden</details>\n\n```ui\n<div>page</div>\n```",
      ),
    );
    const fence = only("ui-fence");
    expect(fence.getAttribute("data-code")).toBe("<div>page</div>");
    expect(fence.getAttribute("data-status")).toBe("closed");
  });

  it("isolates a crash to one fence and tries that fence again when its code changes", async () => {
    function FragileFence(props: CodeFenceProps) {
      if (props.code.includes("{ bad")) {
        throw new Error("fence boom");
      }
      return <UiFence {...props} />;
    }
    claim("demo", FragileFence);
    await show(assistantMessage("```ui\n{ good }\n```\n\n```ui\n{ bad", true));
    expect(renderedFences()).toEqual([
      { code: "{ good }", status: "closed", index: "0" },
    ]);
    expect(container.textContent).toContain("{ bad");
    expect(container.textContent).not.toContain("crashed");
    expect(wrapButtons()).toBe(1);

    await show(
      assistantMessage("```ui\n{ good }\n```\n\n```ui\n{ fixed }\n```", true),
    );
    expect(renderedFences()).toEqual([
      { code: "{ good }", status: "closed", index: "0" },
      { code: "{ fixed }", status: "closed", index: "1" },
    ]);
    expect(wrapButtons()).toBe(0);
  });

  it("renders bb's code block for a language two plugins claim", async () => {
    function ZetaFence() {
      return <div data-testid="zeta-fence" />;
    }
    claim("zeta", ZetaFence, ["ui", "app"]);
    claim("alpha", UiFence);
    await show(
      assistantMessage("```ui\n{ contested }\n```\n\n```app\n{ sole }\n```"),
    );
    expect(all("ui-fence")).toHaveLength(0);
    expect(all("zeta-fence")).toHaveLength(1);
    expect(container.textContent).toContain("{ contested }");
    expect(console.warn).toHaveBeenCalledWith(
      '[plugin] code fence language "ui" claimed by multiple plugins (alpha, zeta); rendering bb\'s code block',
    );
  });

  it("refuses a registration without languages, with a malformed one, or claiming one twice", () => {
    const refusal = (languages: readonly string[], second?: string[]) =>
      registerPluginApp("demo", (bb) => {
        bb.add(threadView.codeFence, { id: "a", languages, view: UiFence });
        if (second !== undefined) {
          bb.add(threadView.codeFence, {
            id: "b",
            languages: second,
            view: UiFence,
          });
        }
      });
    expect(refusal([])?.message).toMatch(/at least one language/u);
    expect(refusal(["UI"])?.message).toMatch(/must match/u);
    expect(refusal(["ui", "ui"])?.message).toMatch(/claimed twice/u);
    expect(refusal(["ui"], ["ui"])?.message).toMatch(/claimed twice/u);
    expect(refusal(["ui", "c++", "f#", "x.y_z-1"])).toBeNull();
  });
});

describe("MarkdownPreview inside a code fence host", () => {
  it.each([
    ["an empty closed fence", "```ui\n```", "closed"],
    ["a closed fence with a blank body", "```ui\n\n```", "closed"],
    ["a longer closing fence", "```ui\na\n`````", "closed"],
    ["a shorter closing run", "````ui\na\n```", "unclosed"],
    ["an over-indented closing run", "```ui\na\n    ```", "unclosed"],
    ["a trailing newline without a closing fence", "```ui\na\n", "unclosed"],
    [
      "a closed fence in a nested list",
      "- x\n\n  - y\n\n    ```ui\n    a\n    ```",
      "closed",
    ],
    [
      "an open fence in a nested list",
      "- x\n\n  - y\n\n    ```ui\n    a\n",
      "unclosed",
    ],
    ["a closed fence in a blockquote", "> ```ui\n> a\n> ```", "closed"],
    ["an open fence in a blockquote", "> ```ui\n> a\n\nafter", "unclosed"],
    ["a closed tilde fence", "~~~ui\na\n~~~", "closed"],
  ])(
    "derives the status from the source for %s",
    async (_label, content, status) => {
      await show(hostedMarkdown([slot(UiFence)], content));
      expect(only("ui-fence").getAttribute("data-status")).toBe(status);
    },
  );

  it("renders bb's original code block through Original", async () => {
    function DelegatingFence({ Original }: CodeFenceProps) {
      return (
        <section data-testid="delegating-fence">
          <Original />
        </section>
      );
    }
    await show(
      hostedMarkdown([slot(DelegatingFence)], "```ui\n{ delegated }\n```"),
    );
    const wrapper = only("delegating-fence");
    expect(wrapper.textContent).toContain("{ delegated }");
    expect(wrapButtons(wrapper)).toBe(1);
  });

  it("leaves fences on bb's code block outside a host", async () => {
    await show(<MarkdownPreview content={"```ui\n{ plain }\n```"} />);
    expect(all("ui-fence")).toHaveLength(0);
    expect(container.textContent).toContain("{ plain }");
  });
});

describe("buildCodeFenceRendererRegistry", () => {
  it("drops a language two plugins claim, keeps the rest, and warns once", () => {
    const warn = vi.fn();
    const alpha = slot(UiFence, {
      pluginId: "alpha",
      languages: ["ui", "app"],
    });
    const zeta = slot(UiFence, { pluginId: "zeta", languages: ["ui"] });
    const registry = buildCodeFenceRendererRegistry([zeta, alpha], { warn });

    expect(registry.has("ui")).toBe(false);
    expect(registry.get("app")).toBe(alpha);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[plugin] code fence language "ui" claimed by multiple plugins (alpha, zeta); rendering bb\'s code block',
    );
  });
});
