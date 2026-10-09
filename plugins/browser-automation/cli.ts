import { posix, win32 } from "node:path";
import {
  cliCommand,
  defineCli,
  machines,
  PluginCliError,
  type CliCommand,
  type CliContext,
  type CliResult,
  type PluginServerApi,
} from "@bb/plugin";
import {
  browserAutomation,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  type Selection,
} from "./contract.js";

const REOPEN_HINT =
  "Open a new session with `bb browser-automation open --backend <desktop|local> --machine <host-id>`.";

const SESSION = {
  name: "session-id",
  description: "Session id returned by `bb browser-automation open`",
  required: true,
} as const;
const THREAD = {
  type: "string",
  placeholder: "id",
  description:
    "Thread that owns the session; defaults to the invoking thread and cannot name another",
} as const;
const JSON_FLAG = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;
const COMMON = { thread: THREAD, json: JSON_FLAG } as const;

export function cliFailure(error: unknown): PluginCliError {
  if (error instanceof PluginCliError) return error;
  const message =
    error instanceof Error ? error.message : "Browser command failed";
  const code =
    typeof error === "object" && error !== null && "cliCode" in error
      ? String(error.cliCode)
      : undefined;
  if (code !== undefined) return new PluginCliError(message, { code });
  if (/stopped or expired|does not belong to this thread/u.test(message)) {
    return new PluginCliError(message, {
      code: "session_unavailable",
      hint: REOPEN_HINT,
    });
  }
  if (/screenshot|JPEG/iu.test(message)) {
    return new PluginCliError(message, {
      code: "screenshot_limit",
      hint: "Return at most 4 JPEG screenshots per run, 500 KB combined.",
    });
  }
  return new PluginCliError(message, { code: "command_failed" });
}

function threadOf(option: string | undefined, ctx: CliContext): string {
  const threadId = option ?? ctx.threadId;
  if (threadId === undefined || threadId === "") {
    throw new PluginCliError("Run from a BB thread or pass --thread <id>", {
      code: "thread_required",
    });
  }
  if (ctx.threadId !== undefined && threadId !== ctx.threadId) {
    throw new PluginCliError(
      "CLI calls from a thread cannot access another thread's browser session",
      { code: "cross_thread" },
    );
  }
  return threadId;
}

export function parseTimeout(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/u.exec(value.trim());
  if (match === null) throw usage(`Invalid --timeout '${value}'`);
  const amount = Number(match[1]);
  const unit = match[2];
  const ms =
    unit === "ms"
      ? amount
      : unit === "m"
        ? amount * 60_000
        : unit === "s" || amount <= MAX_TIMEOUT_MS / 1_000
          ? amount * 1_000
          : amount;
  if (!Number.isInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
    throw usage("--timeout must be between 1s and 120s");
  }
  return ms;
}

function usage(message: string) {
  return new PluginCliError(message, { code: "usage" });
}

function printed(value: unknown, exitCode = 0): CliResult {
  return { exitCode, stdout: JSON.stringify(value) };
}

function guarded<C extends Record<string, CliCommand>>(commands: C): C {
  for (const command of Object.values(commands)) {
    const run = command.run;
    command.run = async (input, ctx) => {
      try {
        return await run(input, ctx);
      } catch (error) {
        throw cliFailure(error);
      }
    };
  }
  return commands;
}

export function registerCli(bb: PluginServerApi): void {
  async function resolveHost(target: string, signal: AbortSignal) {
    const hosts = await bb.call(machines.list, {}, { signal });
    const exact = hosts.find((host) => host.id === target);
    const matches = exact
      ? [exact]
      : hosts.filter((host) => host.name === target);
    if (matches.length === 0)
      throw new Error(`Machine '${target}' was not found`);
    if (matches.length > 1)
      throw new Error(
        `Machine name '${target}' is ambiguous; use an exact host ID`,
      );
    return matches[0]!.id;
  }

  async function readScript(
    file: string,
    hostId: string,
    ctx: CliContext,
  ): Promise<string> {
    const absolute = win32.isAbsolute(file) || posix.isAbsolute(file);
    if (!absolute && !ctx.cwd)
      throw new Error(
        "Relative script files require the invoking CLI working directory",
      );
    const paths = ctx.cwd && win32.isAbsolute(ctx.cwd) ? win32 : posix;
    const path = absolute ? file : paths.resolve(ctx.cwd ?? ".", file);
    const read = await bb.call(
      machines.readFile,
      { hostId, path },
      { signal: ctx.signal },
    );
    if (read.contentEncoding !== "utf8")
      throw new Error("Script file must be UTF-8 text");
    return read.content;
  }

  async function withHost<T extends object>(
    output: T,
    threadId: string,
    sessionId: string,
  ) {
    const sessions = await bb.call(browserAutomation.list, { threadId });
    const hostId = sessions.find((session) => session.id === sessionId)?.hostId;
    return { ...output, ...(hostId === undefined ? {} : { hostId }) };
  }

  const owned = (
    input: {
      options: { thread: string | undefined };
      positionals: { "session-id": string };
    },
    ctx: CliContext,
  ) => ({
    threadId: threadOf(input.options.thread, ctx),
    sessionId: input.positionals["session-id"],
  });

  const capture =
    (op: typeof browserAutomation.pages) =>
    async (
      input: {
        options: { thread: string | undefined };
        positionals: { "session-id": string };
      },
      ctx: CliContext,
    ) => {
      const target = owned(input, ctx);
      const output = await bb.call(op, target, { signal: ctx.signal });
      return printed(
        await withHost(output, target.threadId, target.sessionId),
        output.exitCode,
      );
    };

  bb.cli.register(
    defineCli({
      name: "browser-automation",
      summary: "Persistent DevBrowser desktop and headless sessions",
      commands: guarded({
        open: cliCommand({
          summary:
            "Open a desktop or local headless session; --tab takes over an existing tab",
          options: {
            backend: {
              type: "enum",
              values: ["desktop", "local"],
              required: true,
              description:
                "desktop drives a connected browser instance; local runs headless on the host",
            },
            machine: {
              type: "string",
              required: true,
              placeholder: "name-or-id",
              description:
                "Host that runs the browser: exact ID or unambiguous name",
            },
            desktop: {
              type: "string",
              placeholder: "instance-id",
              description: "Desktop instance to drive (desktop backend only)",
            },
            tab: {
              type: "string",
              placeholder: "tab-id",
              description:
                "Existing desktop tab to control instead of opening one (desktop backend only)",
            },
            headless: {
              type: "boolean",
              description: "Required by the local backend, rejected by desktop",
            },
            ...COMMON,
          },
          run: async ({ options }, ctx) => {
            const threadId = threadOf(options.thread, ctx);
            const { desktop, tab, headless } = options;
            let selection: Selection;
            if (options.backend === "local") {
              if (!headless || desktop !== undefined || tab !== undefined) {
                throw new PluginCliError(
                  "Local sessions require --headless and cannot select desktop tabs",
                  { code: "invalid_selection" },
                );
              }
              selection = { backend: "local", hostId: options.machine };
            } else {
              if (desktop === undefined || headless) {
                throw new PluginCliError(
                  "Desktop sessions require --desktop <instance-id> and cannot use --headless",
                  { code: "invalid_selection" },
                );
              }
              selection = {
                backend: "desktop",
                hostId: options.machine,
                instanceId: desktop,
                ...(tab === undefined ? {} : { tabId: tab }),
              };
            }
            selection.hostId = await resolveHost(
              options.machine.trim(),
              ctx.signal,
            );
            return printed(
              await bb.call(
                browserAutomation.open,
                { threadId, selection },
                { signal: ctx.signal },
              ),
            );
          },
        }),
        list: cliCommand({
          summary: "List this thread's browser sessions",
          options: COMMON,
          run: async ({ options }, ctx) =>
            printed(
              await bb.call(browserAutomation.list, {
                threadId: threadOf(options.thread, ctx),
              }),
            ),
        }),
        run: cliCommand({
          summary:
            "Run a trusted DevBrowser script; runs serialize per session",
          description:
            "Scripts may return at most 4 screenshots per run, JPEG only, 500 KB combined;\nanything larger or in another format fails the run.",
          positionals: [SESSION],
          options: {
            script: {
              type: "string",
              placeholder: "code",
              description: "DevBrowser script source",
            },
            "script-file": {
              type: "string",
              placeholder: "path",
              description: "File holding the script, read from --script-host",
            },
            "script-host": {
              type: "string",
              placeholder: "host-id",
              description: "Host that holds --script-file",
            },
            "timeout-ms": {
              type: "integer",
              description:
                "Run timeout in milliseconds (1000-120000, default 30000)",
            },
            timeout: {
              type: "string",
              placeholder: "duration",
              description:
                "Run timeout as a duration (90s, 2m, 1500ms); a bare number is seconds (1-120) or milliseconds (1000-120000)",
            },
            ...COMMON,
          },
          run: async (input, ctx) => {
            const { options } = input;
            const file = options["script-file"];
            const host = options["script-host"];
            if ((options.script === undefined) === (file === undefined))
              throw usage("Pass exactly one of --script or --script-file");
            if ((file === undefined) !== (host === undefined))
              throw usage("--script-file and --script-host go together");
            if (
              options.timeout !== undefined &&
              options["timeout-ms"] !== undefined
            )
              throw usage("Pass at most one of --timeout or --timeout-ms");
            const timeoutMs =
              options.timeout === undefined
                ? options["timeout-ms"]
                : parseTimeout(options.timeout);
            const target = owned(input, ctx);
            const script =
              file !== undefined && host !== undefined
                ? await readScript(file, host, ctx)
                : (options.script ?? "");
            const output = await bb.call(
              browserAutomation.run,
              { ...target, script, ...(timeoutMs ? { timeoutMs } : {}) },
              { signal: ctx.signal },
            );
            return printed(
              await withHost(output, target.threadId, target.sessionId),
              output.exitCode,
            );
          },
        }),
        pages: cliCommand({
          summary: "Inspect persistent named pages",
          positionals: [SESSION],
          options: COMMON,
          run: capture(browserAutomation.pages),
        }),
        screenshot: cliCommand({
          summary:
            "Save a bounded JPEG in session tmp; return its path and host ID",
          positionals: [SESSION],
          options: {
            page: {
              type: "string",
              placeholder: "name",
              default: "main",
              description: "Named page to capture",
            },
            ...COMMON,
          },
          run: async (input, ctx) => {
            const target = owned(input, ctx);
            const output = await bb.call(
              browserAutomation.screenshot,
              { ...target, page: input.options.page },
              { signal: ctx.signal },
            );
            return printed(
              await withHost(output, target.threadId, target.sessionId),
              output.exitCode,
            );
          },
        }),
        preview: cliCommand({
          summary:
            "Describe the live preview frame of a local headless session, without image bytes",
          positionals: [SESSION],
          options: {
            after: {
              type: "integer",
              default: 0,
              description:
                "Only report a frame newer than this sequence number",
            },
            ...COMMON,
          },
          run: async (input, ctx) => {
            const { session, frame } = await bb.call(
              browserAutomation.preview,
              { ...owned(input, ctx), afterSequence: input.options.after },
              { signal: ctx.signal },
            );
            const { data, ...described } = frame ?? { data: "" };
            return printed({
              session,
              frame: frame && {
                ...described,
                bytes: Buffer.byteLength(data, "base64"),
              },
            });
          },
        }),
        stop: cliCommand({
          summary:
            "Cancel queued and running work and release control; open a new session to resume",
          positionals: [SESSION],
          options: COMMON,
          run: async (input, ctx) =>
            printed(await bb.call(browserAutomation.stop, owned(input, ctx))),
        }),
        close: cliCommand({
          summary:
            "Dispose owned browsers and tabs, preserving handed-off tabs",
          positionals: [SESSION],
          options: COMMON,
          run: async (input, ctx) =>
            printed(await bb.call(browserAutomation.close, owned(input, ctx))),
        }),
      }),
    }),
  );
}
