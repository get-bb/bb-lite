// @vitest-environment jsdom
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPluginAppHost,
  threadView,
  type CodeFenceProps,
  type CodeFenceRenderer,
  type MessageDirective,
  type MessageDirectiveProps,
  type OpState,
  type PluginAppApi,
  type PluginAppHost,
} from "@bb/plugin/app";
import inlineVisApp from "../../../plugins/inline-vis/app";
import type { Preview } from "../../../plugins/inline-vis/contract";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MESSAGE = {
  id: "msg_1",
  threadId: "thr_1",
  turnId: "turn_1",
  projectId: "proj_1",
} as const;

const navigate = {
  openFile: vi.fn(),
  openThreadPanel: vi.fn(() => true),
};

let preview: OpState<Preview> = state(undefined);
let observers: (() => void)[] = [];
let contentHeight = 0;

function state(data: Preview | undefined, error: Error | null = null) {
  const status = error !== null ? "error" : data ? "ready" : "loading";
  return { status, data, error, refetch: () => {} } satisfies OpState<Preview>;
}

const host = {
  createElement,
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
  useOp: () => preview,
  useBbNavigate: () => navigate,
} as unknown as PluginAppHost;

function views() {
  const added = new Map<string, unknown>();
  const bb = {
    add: (slot: { name: string }, item: unknown) => {
      added.set(slot.name, item);
      return () => {};
    },
  } as unknown as PluginAppApi;
  inlineVisApp(bb);
  const fence = added.get(threadView.codeFence.name) as CodeFenceRenderer;
  const directive = added.get(
    threadView.messageDirective.name,
  ) as MessageDirective;
  return { fence, Fence: fence.view, Directive: directive.view };
}

const Original: ComponentType = () => <pre data-testid="original">source</pre>;

function fenceProps(overrides: Partial<CodeFenceProps>): CodeFenceProps {
  return {
    code: "<p>chart</p>",
    language: "inline-vis",
    status: "closed",
    index: 0,
    message: MESSAGE,
    Original,
    ...overrides,
  };
}

function directiveProps(
  attributes: Record<string, string>,
): MessageDirectiveProps {
  return {
    attributes,
    source: "::inline-vis{…}",
    message: MESSAGE,
    openWorkspaceFile: null,
  };
}

let container: HTMLDivElement;
let root: Root;

async function show(element: ReactNode): Promise<void> {
  await act(async () => root.render(element));
  await act(async () => {});
}

function find(selector: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(selector);
}

async function click(selector: string): Promise<void> {
  const target = find(selector);
  expect(target).not.toBeNull();
  await act(async () => target!.click());
}

beforeEach(() => {
  installPluginAppHost(host);
  preview = state(undefined);
  observers = [];
  contentHeight = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly changed: () => void) {}
      observe() {
        observers.push(this.changed);
        this.changed();
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height: contentHeight }) as DOMRect,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  navigate.openFile.mockClear();
  navigate.openThreadPanel.mockClear();
});

describe("inline-vis fenced block", () => {
  it("claims the inline-vis language", () => {
    const { fence } = views();
    expect(fence.id).toBe("inline-vis");
    expect(fence.languages).toEqual(["inline-vis"]);
  });

  it("shows a status line and no frame while the block streams", async () => {
    const { Fence } = views();
    await show(<Fence {...fenceProps({ status: "streaming", code: "<p>" })} />);
    expect(find('[role="status"]')?.textContent).toBe("Writing visualization…");
    expect(find("iframe")).toBeNull();
    expect(find('[data-testid="original"]')).toBeNull();
  });

  it("renders the page in a sandboxed frame once the fence closes", async () => {
    const { Fence } = views();
    await show(<Fence {...fenceProps({})} />);
    const frame = find("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame?.getAttribute("srcdoc")).toContain("<p>chart</p>");
    expect(find('[data-testid="original"]')).toBeNull();
  });

  it("shows and hides the source from the hover action", async () => {
    const { Fence } = views();
    await show(<Fence {...fenceProps({})} />);
    await click('button[aria-label="Show source"]');
    expect(find('[data-testid="original"]')).not.toBeNull();
    expect(find("iframe")).not.toBeNull();
    await click('button[aria-label="Hide source"]');
    expect(find('[data-testid="original"]')).toBeNull();
  });

  it.each([
    ["a block the reply never closed", { status: "unclosed" }],
    ["an empty block", { code: " \n" }],
  ] as const)("falls back to bb's code block for %s", async (_label, props) => {
    const { Fence } = views();
    await show(<Fence {...fenceProps(props)} />);
    expect(find('[data-testid="original"]')).not.toBeNull();
    expect(find("iframe")).toBeNull();
  });
});

describe("inline-vis directive", () => {
  const markdown: Preview = {
    kind: "markdown",
    file: "reports/summary.md",
    source: "workspace",
    url: "/files/reports/summary.md",
    content: "# Summary",
  };

  it("accepts a height from 80 to 2000 and refuses others", async () => {
    const { Directive } = views();
    for (const height of ["79", "2001", "12.5", "tall"]) {
      await show(<Directive {...directiveProps({ file: "a.html", height })} />);
      expect(find('[role="alert"]')?.textContent).toContain(
        "from 80 to 2000 pixels",
      );
    }
    for (const height of ["80", "2000"]) {
      await show(<Directive {...directiveProps({ file: "a.html", height })} />);
      expect(find('[role="alert"]')).toBeNull();
      expect(find('[role="status"]')?.style.height).toBe(`${height}px`);
    }
  });

  it("shows an HTML file as a frame with an action that opens the side panel", async () => {
    preview = state({
      kind: "html",
      file: "charts/out.html",
      source: "workspace",
      url: "/files/charts/out.html",
      content: "<h1>chart</h1>",
      sha256: "abc",
    });
    const { Directive } = views();
    await show(<Directive {...directiveProps({ file: "charts/out.html" })} />);
    const frame = find("iframe");
    expect(frame?.getAttribute("title")).toBe("inline-vis: charts/out.html");
    expect(frame?.getAttribute("srcdoc")).toContain("<h1>chart</h1>");
    await click('a[aria-label="Open in sidebar: charts/out.html"]');
    expect(navigate.openThreadPanel).toHaveBeenCalledWith({
      actionId: "preview",
      title: "out.html",
      params: { file: "charts/out.html", source: "workspace" },
    });
  });

  it("shows a Markdown file in a card with its name, folder, copy and open actions", async () => {
    preview = state(markdown);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { Directive } = views();
    await show(
      <Directive {...directiveProps({ file: "reports/summary.md" })} />,
    );
    const card = find('section[aria-label="reports/summary.md"]');
    expect(card?.querySelector("header")?.textContent).toBe(
      "summary.mdreports",
    );
    expect(find('[data-testid="markdown"]')?.textContent).toBe("# Summary");
    expect(find("[aria-expanded]")).toBeNull();

    await click('button[aria-label="Copy reports/summary.md"]');
    expect(writeText).toHaveBeenCalledWith("# Summary");
    expect(find('[data-icon="Check"]')).not.toBeNull();

    await click('button[aria-label="Open in sidebar: reports/summary.md"]');
    expect(navigate.openFile).toHaveBeenCalledWith({
      threadId: "thr_1",
      path: "reports/summary.md",
      source: "workspace",
    });
  });

  it("previews a long document and expands it in place, remembering the choice", async () => {
    preview = state(markdown);
    contentHeight = 900;
    const { Directive } = views();
    const element = (
      <Directive
        {...directiveProps({ file: "reports/summary.md", height: "300" })}
      />
    );
    await show(element);
    const body = () => find("[data-inline-vis-document]");
    expect(body()?.style.maxHeight).toBe("300px");
    expect(find('[aria-expanded="false"]')?.textContent).toBe("Show more");

    await click('[aria-expanded="false"]');
    expect(body()?.style.maxHeight).toBe("");
    expect(find('[aria-expanded="true"]')?.textContent).toBe("Show less");

    await show(null);
    await show(element);
    expect(find('[aria-expanded="true"]')).not.toBeNull();

    await click('[aria-expanded="true"]');
    expect(body()?.style.maxHeight).toBe("300px");
  });

  it("leaves a document that fits within the preview and its slack unclamped", async () => {
    preview = state(markdown);
    contentHeight = 256 + 64;
    const { Directive } = views();
    await show(
      <Directive {...directiveProps({ file: "reports/summary.md" })} />,
    );
    expect(find("[data-inline-vis-document]")?.style.maxHeight).toBe("");
    expect(find("[aria-expanded]")).toBeNull();
    contentHeight = 256 + 65;
    await act(async () => observers.forEach((changed) => changed()));
    expect(find("[data-inline-vis-document]")?.style.maxHeight).toBe("256px");
    expect(find('[aria-expanded="false"]')).not.toBeNull();
  });

  it("shows a skeleton card while a Markdown file loads and an error when it is missing", async () => {
    const { Directive } = views();
    await show(<Directive {...directiveProps({ file: "notes.md" })} />);
    expect(find('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Loading document notes.md",
    );
    preview = state({ kind: "not-found", file: "notes.md" });
    await show(<Directive {...directiveProps({ file: "notes.md" })} />);
    expect(find('[role="alert"]')?.textContent).toContain(
      "Preview file not found: notes.md",
    );
  });
});
