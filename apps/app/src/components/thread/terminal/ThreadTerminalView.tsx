import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { ITheme, Terminal as XTermTerminal } from "@xterm/xterm";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import {
  buildTerminalWebSocketPath,
  TerminalWebSocketTransport,
} from "@bb/client-core";
import { useAppThemeEpoch } from "@/hooks/useAppTheme";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  openUrlInExternalBrowser,
  useAppNavigationHost,
} from "@/lib/url-open-routing";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { buildBrowserWebSocketUrl } from "@/lib/browser-websocket-url";

const TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const ANSI_COLOR_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function buildTerminalTheme(): ITheme {
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const rootStyle = getComputedStyle(document.documentElement);
  const get = (name: string) => {
    const raw = rootStyle.getPropertyValue(name).trim();
    if (!raw) return undefined;
    probe.style.color = raw;
    return getComputedStyle(probe).color;
  };
  const theme: ITheme = {
    background: get("--sidebar"),
    foreground: get("--foreground"),
    cursor: get("--foreground"),
    cursorAccent: get("--sidebar"),
    selectionBackground: get("--muted"),
  };
  ANSI_COLOR_KEYS.forEach((key, index) => {
    theme[key] = get(`--ansi-${index}`);
  });
  probe.remove();
  return theme;
}

function readTerminalFontFamily(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--font-terminal")
      .trim() || TERMINAL_FONT_FAMILY
  );
}

function encodeTerminalInputChunks(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength;) {
    const end = Math.min(offset + TERMINAL_DATA_MAX_BYTES, bytes.byteLength);
    let binary = "";
    for (const byte of bytes.subarray(offset, end)) {
      binary += String.fromCharCode(byte);
    }
    chunks.push(btoa(binary));
    offset = end;
  }
  return chunks;
}

function writeTerminalStatus(terminal: XTermTerminal, text: string): void {
  terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
}

function exitedText(session: TerminalSession): string {
  return session.exitCode === null
    ? "Terminal exited"
    : `Terminal exited with code ${session.exitCode}`;
}

function writeSessionStatusNotice(
  terminal: XTermTerminal,
  session: TerminalSession,
  lastNotice: { current: TerminalSession["status"] | null },
): void {
  const { status } = session;
  if (status !== "disconnected" && status !== "exited") {
    lastNotice.current = null;
  } else if (lastNotice.current !== status) {
    lastNotice.current = status;
    writeTerminalStatus(
      terminal,
      status === "exited" ? exitedText(session) : "Terminal disconnected",
    );
  }
}

interface ThreadTerminalViewProps {
  autoFocus: boolean;
  isPanelOpen: boolean;
  onAutoFocusHandled?: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  onSessionChange: (session: TerminalSession) => void;
  onTitleChange: (title: string) => void;
  session: TerminalSession;
}

export function ThreadTerminalView(props: ThreadTerminalViewProps) {
  const { autoFocus, isPanelOpen, session } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const scheduleFitRef = useRef<(() => void) | null>(null);
  const lastStatusNoticeRef = useRef<TerminalSession["status"] | null>(null);
  const preferredTheme = usePreferredTheme();
  const appThemeEpoch = useAppThemeEpoch();
  const appNavigation = useAppNavigationHost();
  const latest = useRef({ ...props, appNavigation });
  latest.current = { ...props, appNavigation };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const activeElementAtMount = document.activeElement;
    let disposed = false;
    const cleanups: (() => void)[] = [];

    async function mountTerminal(containerElement: HTMLDivElement) {
      const [
        { Terminal },
        { FitAddon },
        { WebLinksAddon },
        { Unicode11Addon },
        webgl,
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-webgl").catch(() => null),
      ]);
      if (disposed) return;
      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: true,
        cursorBlink: true,
        fontFamily: readTerminalFontFamily(),
        fontSize: 12,
        scrollback: 10_000,
        theme: buildTerminalTheme(),
      });
      terminalRef.current = terminal;
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = "11";
      terminal.loadAddon(
        new WebLinksAddon((event, uri) => {
          if (event.button !== 0) return;
          const { onOpenLink, appNavigation: navigation } = latest.current;
          const handled = onOpenLink
            ? onOpenLink({ href: uri })
            : navigation.openUrl({ url: uri });
          if (!handled) openUrlInExternalBrowser(uri);
        }),
      );
      try {
        const webglAddon = webgl === null ? null : new webgl.WebglAddon();
        webglAddon?.onContextLoss(() => webglAddon.dispose());
        if (webglAddon) terminal.loadAddon(webglAddon);
      } catch {}
      terminal.open(containerElement);
      writeSessionStatusNotice(
        terminal,
        latest.current.session,
        lastStatusNoticeRef,
      );

      let replayNextSeq: number | null = null;
      let pendingReplayWrites = 0;
      let hasOpened = false;
      let reconnectNoticeVisible = false;
      const isRunning = () => latest.current.session.status === "running";
      const handleMessage = (message: TerminalServerMessage) => {
        switch (message.type) {
          case "attached":
            latest.current.onSessionChange(message.session);
            replayNextSeq = message.nextSeq;
            return;
          case "session-updated":
            latest.current.onSessionChange(message.session);
            return;
          case "output": {
            const data = decodeBase64Bytes(message.chunk.dataBase64);
            if (replayNextSeq === null || message.chunk.seq >= replayNextSeq) {
              terminal.write(data);
              return;
            }
            pendingReplayWrites += 1;
            terminal.write(data, () => {
              pendingReplayWrites -= 1;
            });
            return;
          }
          case "error":
            writeTerminalStatus(terminal, `Terminal error: ${message.message}`);
            return;
          case "exited":
            latest.current.onSessionChange(message.session);
            writeTerminalStatus(terminal, exitedText(message.session));
            return;
          case "pong":
            return;
        }
      };
      const transport = new TerminalWebSocketTransport({
        onConnectionState: (state) => {
          if (disposed) return;
          if (state === "reconnecting" && !reconnectNoticeVisible) {
            reconnectNoticeVisible = true;
            writeTerminalStatus(
              terminal,
              "Terminal connection lost; reconnecting...",
            );
          } else if (state === "open") {
            if (hasOpened && reconnectNoticeVisible) {
              writeTerminalStatus(terminal, "Terminal reconnected");
            }
            hasOpened = true;
            reconnectNoticeVisible = false;
          }
        },
        onInputOverflow: (maxBytes) =>
          writeTerminalStatus(
            terminal,
            `Terminal input queue is full (${maxBytes} bytes); input was not sent`,
          ),
        onInvalidMessage: () =>
          writeTerminalStatus(
            terminal,
            "Terminal received an invalid server message",
          ),
        onMessage: handleMessage,
        onSequenceGap: () => {
          terminal.reset();
          writeTerminalStatus(
            terminal,
            "Some terminal output was unavailable after reconnect",
          );
        },
        shouldReconnect: () => !disposed && isRunning(),
        url: buildBrowserWebSocketUrl(
          buildTerminalWebSocketPath({ terminalId: session.id }),
        ),
      });

      let fitFrame: number | null = null;
      const fitTerminal = () => {
        fitFrame = null;
        if (
          containerElement.clientWidth <= 0 ||
          containerElement.clientHeight <= 0
        ) {
          return;
        }
        fitAddon.fit();
        transport.sendResize(terminal.cols, terminal.rows);
      };
      const scheduleFit = () => {
        fitFrame ??= window.requestAnimationFrame(fitTerminal);
      };
      fitTerminal();
      scheduleFitRef.current = scheduleFit;
      const refreshFonts = () => {
        if (disposed) return;
        const fontFamily = terminal.options.fontFamily;
        terminal.options.fontFamily = `${fontFamily} `;
        terminal.options.fontFamily = fontFamily;
        terminal.clearTextureAtlas();
        terminal.refresh(0, terminal.rows - 1);
        scheduleFit();
      };
      document.fonts.addEventListener("loadingdone", refreshFonts);
      void document.fonts.ready.then(refreshFonts);
      const resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(containerElement);

      const focused = document.activeElement;
      const hasFocus =
        focused !== null && focused !== document.body && focused.isConnected;
      if (
        latest.current.isPanelOpen &&
        !(focused !== activeElementAtMount && hasFocus) &&
        (latest.current.autoFocus || !hasFocus)
      ) {
        terminal.focus();
        latest.current.onAutoFocusHandled?.();
      }

      transport.sendResize(terminal.cols, terminal.rows);
      transport.start();
      terminal.onData((data) => {
        if (pendingReplayWrites > 0 || !isRunning()) return;
        for (const chunk of encodeTerminalInputChunks(data)) {
          transport.sendInput(chunk);
        }
      });
      terminal.onTitleChange((title) => {
        if (pendingReplayWrites === 0 && isRunning()) {
          latest.current.onTitleChange(title);
        }
      });
      cleanups.push(() => {
        document.fonts.removeEventListener("loadingdone", refreshFonts);
        if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
        resizeObserver.disconnect();
        transport.dispose();
        terminal.dispose();
      });
    }

    void mountTerminal(container).catch((error) => {
      if (!disposed) {
        container.textContent =
          error instanceof Error ? error.message : String(error);
      }
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      terminalRef.current = null;
      scheduleFitRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    if (!isPanelOpen || !autoFocus) return;
    if (terminalRef.current !== null) {
      terminalRef.current.focus();
      latest.current.onAutoFocusHandled?.();
    }
    scheduleFitRef.current?.();
  }, [autoFocus, isPanelOpen]);

  useEffect(() => {
    if (terminalRef.current) {
      writeSessionStatusNotice(
        terminalRef.current,
        session,
        lastStatusNoticeRef,
      );
    }
  }, [session]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const fontFamily = readTerminalFontFamily();
    if (terminal.options.fontFamily !== fontFamily) {
      terminal.options.fontFamily = fontFamily;
      scheduleFitRef.current?.();
    }
    terminal.options.theme = buildTerminalTheme();
  }, [preferredTheme, appThemeEpoch]);

  return (
    <div className="h-full min-h-0 w-full overflow-hidden bg-sidebar p-2">
      <div
        ref={containerRef}
        className="h-full min-h-0 w-full overflow-hidden"
      />
    </div>
  );
}
