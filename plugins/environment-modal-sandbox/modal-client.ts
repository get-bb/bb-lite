import { createHash } from "node:crypto";
import { ModalClient as Modal, NotFoundError, type Sandbox } from "modal";
import { z } from "zod";
import type {
  ModalApi,
  ModalClient,
  ModalCredentials,
  ModalExecOptions,
} from "./modal-api.js";

const EXEC_TIMEOUT_MS = 600_000;
const SNAPSHOT_TIMEOUT_MS = 300_000;
const IMAGE_LOGS = "/modal.client.ModalClient/ImageJoinStreaming";
const logsSchema = z.object({
  taskLogs: z.array(z.object({ data: z.string() })),
});
const identitySchema = z.object({ workspaceId: z.string().min(1) });

export function parseDockerfile(dockerfile: string) {
  const lines = dockerfile
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const from = /^FROM (\S+)$/.exec(lines[0] ?? "");
  const commands = lines.slice(1);
  if (
    from?.[1] === undefined ||
    commands.some((line) => !/^(RUN|ENV|WORKDIR|USER) /.test(line))
  ) {
    throw new Error(
      "The Modal Dockerfile requires one FROM followed by RUN, ENV, WORKDIR or USER instructions",
    );
  }
  const hash = createHash("sha256").update(dockerfile).digest("hex");
  return { reference: from[1], commands, name: `bb-standard:${hash}` };
}

const seconds = (ms: number) => Math.max(1000, Math.floor(ms / 1000) * 1000);

async function collect(stream: AsyncIterable<string>, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const data = Buffer.from(chunk);
    const kept = data.subarray(0, Math.max(0, maxBytes - size));
    if (kept.length < data.length) truncated = true;
    chunks.push(kept);
    size += kept.length;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${text}\n[output truncated]` : text;
}

async function orNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

function connect(credentials: ModalCredentials): {
  client: ModalClient;
  close(): void;
} {
  const { tokenId, tokenSecret } = credentials;
  const modal = new Modal({ tokenId, tokenSecret });
  const sandboxes = new Map<string, Sandbox>();

  async function sandbox(sandboxId: string): Promise<Sandbox> {
    const known = sandboxes.get(sandboxId);
    if (known !== undefined) return known;
    const found = await modal.sandboxes.fromId(sandboxId);
    sandboxes.set(sandboxId, found);
    return found;
  }

  async function exec(
    sandboxId: string,
    command: string[],
    options: ModalExecOptions = {},
  ) {
    const maxBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    const process = await (
      await sandbox(sandboxId)
    ).exec(command, {
      mode: "text",
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: seconds(options.timeoutMs ?? EXEC_TIMEOUT_MS),
    });
    await process.stdin.close();
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(process.stdout, maxBytes),
      collect(process.stderr, maxBytes),
      process.wait(),
    ]);
    return { exitCode, stdout, stderr };
  }

  async function ensureImage(request: {
    appName: string;
    dockerfile: string;
    signal: AbortSignal;
    log?: (line: string) => void;
  }) {
    const definition = parseDockerfile(request.dockerfile);
    const existing = await orNull(() => modal.images.fromName(definition.name));
    request.signal.throwIfAborted();
    if (existing !== null) return existing.imageId;
    const builder = new Modal({
      tokenId,
      tokenSecret,
      grpcMiddleware: [
        async function* (call, options) {
          const responses = call.next(call.request, options);
          while (true) {
            const next = await responses.next();
            if (next.done) return next.value;
            if (call.method.path === IMAGE_LOGS) {
              const parsed = logsSchema.safeParse(next.value);
              for (const log of parsed.data?.taskLogs ?? []) {
                request.log?.(log.data);
              }
            }
            yield next.value;
          }
        },
      ],
    });
    try {
      const app = await builder.apps.fromName(request.appName, {
        createIfMissing: true,
      });
      request.signal.throwIfAborted();
      const image = await builder.images
        .fromRegistry(definition.reference)
        .dockerfileCommands(definition.commands)
        .build(app);
      await image.publish(definition.name);
      return image.imageId;
    } finally {
      builder.close();
    }
  }

  const client: ModalClient = {
    async accountIdentity() {
      const identity = identitySchema.parse(
        await modal.cpClient.tokenInfoGet({}),
      );
      return createHash("sha256").update(identity.workspaceId).digest("hex");
    },
    ensureImage,
    async create(spec) {
      const existing = await orNull(() =>
        modal.sandboxes.fromName(spec.appName, spec.name),
      );
      if (existing !== null && (await existing.poll()) === null) {
        sandboxes.set(existing.sandboxId, existing);
        return existing.sandboxId;
      }
      const app = await modal.apps.fromName(spec.appName, {
        createIfMissing: true,
      });
      const image = await modal.images.fromId(spec.imageId);
      const created = await modal.sandboxes.create(app, image, {
        name: spec.name,
        timeoutMs: spec.timeoutMs,
        tags: spec.tags,
        env: {},
        cpu: spec.cpu,
        memoryMiB: spec.memoryMiB,
      });
      sandboxes.set(created.sandboxId, created);
      return created.sandboxId;
    },
    async running(sandboxId) {
      const found = await orNull(() => sandbox(sandboxId));
      return found !== null && (await found.poll()) === null;
    },
    exec,
    async snapshot(sandboxId) {
      const image = await (
        await sandbox(sandboxId)
      ).snapshotFilesystem({ timeoutMs: SNAPSHOT_TIMEOUT_MS });
      return image.imageId;
    },
    async terminate(sandboxId) {
      const found = await orNull(() => sandbox(sandboxId));
      sandboxes.delete(sandboxId);
      await found?.terminate();
    },
    async deleteSnapshot(imageId) {
      await orNull(() => modal.images.delete(imageId));
    },
  };
  return { client, close: () => modal.close() };
}

export function createModalApi(): ModalApi & { close(): void } {
  let cached: {
    token: string;
    connection: ReturnType<typeof connect>;
  } | null = null;
  return {
    connect(credentials) {
      const token = `${credentials.tokenId}:${credentials.tokenSecret}`;
      if (cached?.token === token) return cached.connection.client;
      cached?.connection.close();
      cached = { token, connection: connect(credentials) };
      return cached.connection.client;
    },
    close() {
      cached?.connection.close();
      cached = null;
    },
  };
}
