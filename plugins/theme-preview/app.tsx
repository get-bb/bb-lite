import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Pill } from "@bb/shared-ui/pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Switch } from "@bb/shared-ui/switch";
import {
  server,
  settings,
  shell,
  useCall,
  useOp,
  type PluginAppApi,
} from "@bb/plugin/app";
import { contrastRatio } from "./contrast";
import { themePreview, type ThemeSwatch } from "./contract";

type Mode = "light" | "dark";
type Area = "preview" | "components" | "stylesheet";
type Contrast = "none" | "vs-surface" | "as-painted";

const AREAS: [Area, string][] = [
  ["preview", "Preview"],
  ["components", "Components"],
  ["stylesheet", "Style sheet"],
];

const COLOR_GROUPS: { title: string; contrast: Contrast; tokens: string[] }[] =
  [
    {
      title: "Surfaces",
      contrast: "none",
      tokens: [
        "canvas",
        "sidebar",
        "card",
        "popover",
        "secondary",
        "muted",
        "surface-recessed-solid",
        "surface-scrim",
      ],
    },
    {
      title: "Ink",
      contrast: "vs-surface",
      tokens: [
        "ink",
        "foreground",
        "muted-foreground",
        "subtle-foreground",
        "readback-foreground",
        "sidebar-foreground",
      ],
    },
    {
      title: "Accent",
      contrast: "none",
      tokens: [
        "primary",
        "file-accent",
        "timeline-accent",
        "surface-selected",
        "state-hover",
        "state-active",
      ],
    },
    {
      title: "Status",
      contrast: "as-painted",
      tokens: [
        "success",
        "warning",
        "attention",
        "destructive",
        "pr-merged",
        "diff-added",
        "diff-removed",
      ],
    },
    {
      title: "Lines",
      contrast: "none",
      tokens: [
        "border",
        "border-hairline",
        "border-seam",
        "sidebar-border",
        "input",
        "ring",
      ],
    },
  ];

const FONT_TOKENS = ["font-sans", "font-mono", "font-terminal", "radius"];

function paintedColor(probe: HTMLElement, token: string): string | null {
  probe.style.backgroundColor = `var(--${token})`;
  const computed = getComputedStyle(probe).backgroundColor;
  const context = document.createElement("canvas").getContext("2d");
  if (!computed || !context) return null;
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

function surfaceFor(token: string): string {
  return token.startsWith("sidebar") ? "sidebar" : "canvas";
}

function Swatches({ swatch }: { swatch: ThemeSwatch | null }) {
  const colors = [swatch?.canvas, swatch?.primary, swatch?.accent];
  return (
    <span className="flex gap-0.5">
      {colors.map((color, index) => (
        <span
          key={index}
          className="size-3 rounded-full border border-border"
          style={{ background: color ?? "transparent" }}
        />
      ))}
    </span>
  );
}

function ThemePreviewPanel() {
  const catalog = useOp(themePreview.catalog, {});
  const config = useOp(server.config, {});
  const updateAppearance = useCall(settings.updateAppearance);
  const [mode, setMode] = useState<Mode>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const [area, setArea] = useState<Area>("preview");
  const [error, setError] = useState<string | null>(null);
  const data = catalog.data;

  async function choose(themeId: string) {
    setError(null);
    const faviconColor = config.data?.appearance.faviconColor ?? "default";
    try {
      await updateAppearance({ themeId, faviconColor });
      await Promise.all([catalog.refetch(), config.refetch()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Select value={data?.activeThemeId} onValueChange={choose}>
          <SelectTrigger className="w-56" aria-label="Theme">
            <SelectValue placeholder="Theme" />
          </SelectTrigger>
          <SelectContent>
            {data?.themes.map((theme) => (
              <SelectItem key={theme.id} value={theme.id}>
                <span className="flex items-center gap-2">
                  <Swatches swatch={theme[mode]} />
                  {theme.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
        >
          {mode === "dark" ? "Dark" : "Light"}
        </Button>
        <nav className="ml-auto flex gap-1">
          {AREAS.map(([id, label]) => (
            <Button
              key={id}
              variant="ghost"
              size="sm"
              aria-pressed={area === id}
              onClick={() => setArea(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        {error ? (
          <p className="w-full text-xs text-destructive-text">{error}</p>
        ) : null}
      </header>
      <div
        className={`${mode} flex-1 overflow-y-auto bg-canvas p-4 text-ink`}
        style={{ colorScheme: mode }}
      >
        {area === "preview" ? <MockThread /> : null}
        {area === "components" ? <Components /> : null}
        {area === "stylesheet" ? (
          <StyleSheet
            key={`${data?.activeThemeId}:${data?.revision}:${mode}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function MockThread() {
  const rows = ["Fix flaky login test", "Theme: dusk palette", "Release notes"];
  return (
    <div className="flex h-[480px] overflow-hidden rounded-lg border border-border-seam">
      <aside className="flex w-56 flex-col gap-0.5 border-r border-sidebar-border bg-sidebar p-2 text-sm text-sidebar-foreground">
        {rows.map((title, index) => (
          <div
            key={title}
            className={`rounded-md px-2 py-1.5 ${index === 1 ? "bg-state-active" : index === 0 ? "bg-sidebar-accent" : ""}`}
          >
            {title}
          </div>
        ))}
      </aside>
      <main className="flex flex-1 flex-col gap-3 p-4 text-sm">
        <div className="ml-auto max-w-[70%] rounded-lg border border-border-seam bg-secondary px-3 py-2">
          Make the sidebar a little warmer and check contrast.
        </div>
        <p>
          Updated <span className="text-file-accent">theme.css</span>. The
          sidebar now uses a warmer tint;{" "}
          <span className="text-muted-foreground">muted copy</span> and{" "}
          <a className="text-primary underline">links</a> keep their ratio.
        </p>
        <pre className="rounded-md border border-border-seam bg-muted p-2 font-mono text-xs">
          <div className="bg-diff-added/20">+ --sidebar: #f1ece4;</div>
          <div className="bg-diff-removed/20">- --sidebar: #f4f4f4;</div>
        </pre>
        <div className="flex gap-2">
          <Pill variant="secondary">
            <span className="text-success">Checks passed</span>
          </Pill>
          <Pill variant="outline">
            <span className="text-pr-merged">Merged</span>
          </Pill>
        </div>
        <div className="mt-auto flex items-end gap-2 rounded-xl border border-border bg-canvas p-2 ring-2 ring-ring/40">
          <span className="flex-1 text-subtle-foreground">
            Ask for changes…
          </span>
          <Button size="sm">Send</Button>
        </div>
      </main>
    </div>
  );
}

function Components() {
  const [on, setOn] = useState(true);
  const variants = [
    "default",
    "secondary",
    "outline",
    "ghost",
    "destructive",
    "link",
  ] as const;
  return (
    <div className="flex max-w-3xl flex-col gap-6 text-sm">
      <section className="flex flex-wrap gap-2">
        {variants.map((variant) => (
          <Button key={variant} variant={variant} size="sm">
            {variant}
          </Button>
        ))}
      </section>
      <section className="flex items-center gap-3">
        <Input placeholder="Search threads" className="max-w-xs" />
        <Switch checked={on} onCheckedChange={setOn} aria-label="Switch" />
        <Pill variant="secondary">Draft</Pill>
        <Pill variant="destructive">Failed</Pill>
        <Pill variant="outline">Idle</Pill>
      </section>
      <section className="relative h-56 overflow-hidden rounded-lg border border-border">
        <div className="absolute inset-0 bg-surface-scrim" />
        <div className="absolute top-6 left-6 w-72 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg">
          <p className="font-medium">Delete thread?</p>
          <p className="mt-1 text-muted-foreground">This cannot be undone.</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="sm">
              Cancel
            </Button>
            <Button variant="destructive" size="sm">
              Delete
            </Button>
          </div>
        </div>
        <div className="absolute top-6 right-6 w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {["Rename", "Pin", "Archive"].map((item, index) => (
            <div
              key={item}
              className={`rounded px-2 py-1 ${index === 1 ? "bg-state-hover" : ""}`}
            >
              {item}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

type Row = {
  token: string;
  value: string;
  ratio: number | null;
  against: string | null;
};

function StyleSheet() {
  const root = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const probe = document.createElement("span");
    element.append(probe);
    const style = getComputedStyle(element);
    const next: Record<string, Row> = {};
    for (const group of COLOR_GROUPS) {
      for (const token of group.tokens) {
        const value = style.getPropertyValue(`--${token}`).trim();
        const against = group.contrast === "none" ? null : surfaceFor(token);
        const fg = paintedColor(probe, token);
        const bg = against ? paintedColor(probe, against) : null;
        const ratio = fg && bg ? contrastRatio(fg, bg) : null;
        next[token] = { token, value, ratio, against };
      }
    }
    for (const token of FONT_TOKENS) {
      const value = style.getPropertyValue(`--${token}`).trim();
      next[token] = { token, value, ratio: null, against: null };
    }
    probe.remove();
    setRows(next);
  }, []);
  return (
    <div ref={root} className="flex max-w-3xl flex-col gap-5 text-sm">
      {COLOR_GROUPS.map((group) => (
        <section key={group.title}>
          <h3 className="mb-2 font-medium">{group.title}</h3>
          {group.tokens.map((token) => (
            <TokenRow key={token} token={token} row={rows[token]} color />
          ))}
        </section>
      ))}
      <section>
        <h3 className="mb-2 font-medium">Type and shape</h3>
        {FONT_TOKENS.map((token) => (
          <TokenRow key={token} token={token} row={rows[token]} />
        ))}
      </section>
    </div>
  );
}

function TokenRow({
  token,
  row,
  color = false,
}: {
  token: string;
  row: Row | undefined;
  color?: boolean;
}) {
  const ratio = row?.ratio;
  const passes = ratio != null && ratio >= 4.5;
  return (
    <div className="flex items-center gap-3 border-b border-border-hairline py-1.5">
      {color ? (
        <span
          className="size-5 shrink-0 rounded border border-border"
          style={{ background: `var(--${token})` }}
        />
      ) : null}
      <code className="w-56 shrink-0 font-mono text-xs">--{token}</code>
      <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
        {row?.value || "not set"}
      </span>
      {ratio != null ? (
        <span
          className={`font-mono text-xs ${passes ? "text-success" : "text-destructive-text"}`}
          title={`Contrast against --${row?.against}`}
        >
          {ratio.toFixed(2)}:1
        </span>
      ) : null}
    </div>
  );
}

export default function themePreviewApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "theme-preview",
    title: "Theme Preview",
    icon: "Palette",
    path: "theme-preview",
    view: ThemePreviewPanel,
  });
}
