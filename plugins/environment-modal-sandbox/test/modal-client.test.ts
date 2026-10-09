import { beforeEach, expect, it, vi } from "vitest";
import { createModalApi } from "../modal-client.js";

const calls: string[] = [];
const state = {
  namedImage: false,
  namedSandbox: null as string | null,
};

vi.mock("modal", () => {
  class NotFoundError extends Error {}
  const sandbox = (sandboxId: string) => ({
    sandboxId,
    poll: async () => null,
    terminate: async () => void calls.push(`terminate ${sandboxId}`),
    snapshotFilesystem: async () => ({ imageId: `im-snap-${sandboxId}` }),
    exec: async (command: string[]) => ({
      stdin: { close: async () => {} },
      stdout: (async function* () {
        yield command.join(" ");
      })(),
      stderr: (async function* () {})(),
      wait: async () => 3,
    }),
  });
  class ModalClient {
    constructor(options: { tokenId: string }) {
      calls.push(`connect ${options.tokenId}`);
    }
    close() {
      calls.push("close");
    }
    cpClient = { tokenInfoGet: async () => ({ workspaceId: "ws-1" }) };
    apps = { fromName: async (name: string) => ({ appId: `ap-${name}` }) };
    images = {
      fromName: async (name: string) => {
        if (!state.namedImage) throw new NotFoundError(name);
        return { imageId: "im-named" };
      },
      fromId: async (imageId: string) => ({ imageId }),
      delete: async (imageId: string) => {
        throw new NotFoundError(imageId);
      },
      fromRegistry: (reference: string) => ({
        dockerfileCommands: (commands: string[]) => ({
          build: async () => {
            calls.push(`build ${reference} ${commands.length}`);
            return {
              imageId: "im-built",
              publish: async (name: string) =>
                void calls.push(`publish ${name.slice(0, 12)}`),
            };
          },
        }),
      }),
    };
    sandboxes = {
      fromName: async (_app: string, name: string) => {
        if (state.namedSandbox === null) throw new NotFoundError(name);
        return sandbox(state.namedSandbox);
      },
      fromId: async (sandboxId: string) => sandbox(sandboxId),
      create: async (_app: unknown, image: { imageId: string }) => {
        calls.push(`create from ${image.imageId}`);
        return sandbox("sb-new");
      },
    };
  }
  return { ModalClient, NotFoundError };
});

beforeEach(() => {
  calls.length = 0;
  state.namedImage = false;
  state.namedSandbox = null;
});

const credentials = { tokenId: "ak-1", tokenSecret: "as-1" };
const spec = {
  appName: "bb-sandboxes",
  name: "bb-thr",
  imageId: "im-built",
  timeoutMs: 1000,
  cpu: 1,
  memoryMiB: 2048,
  tags: {},
};

it("builds and publishes an image once, then reuses it by name", async () => {
  const api = createModalApi();
  const client = api.connect(credentials);
  const request = {
    appName: "bb-sandboxes",
    dockerfile: "FROM node:22\nRUN true\n",
    signal: new AbortController().signal,
  };
  expect(await client.ensureImage(request)).toBe("im-built");
  state.namedImage = true;
  expect(await client.ensureImage(request)).toBe("im-named");
  expect(calls).toEqual([
    "connect ak-1",
    "connect ak-1",
    "build node:22 1",
    "publish bb-standard:",
    "close",
  ]);
  expect(await client.accountIdentity()).toMatch(/^[0-9a-f]{64}$/u);
});

it("reuses a running sandbox of the same name and wraps exec, snapshot and delete", async () => {
  const api = createModalApi();
  const client = api.connect(credentials);
  expect(await client.create(spec)).toBe("sb-new");
  state.namedSandbox = "sb-old";
  expect(await client.create(spec)).toBe("sb-old");
  expect(await client.exec("sb-old", ["echo", "hi"])).toEqual({
    exitCode: 3,
    stdout: "echo hi",
    stderr: "",
  });
  expect(
    await client.exec("sb-old", ["echo", "long"], { maxOutputBytes: 4 }),
  ).toMatchObject({ stdout: "echo\n[output truncated]" });
  expect(await client.snapshot("sb-old")).toBe("im-snap-sb-old");
  await client.deleteSnapshot("im-gone");
  await client.terminate("sb-old");
  expect(await client.running("sb-old")).toBe(true);
  expect(calls).toEqual([
    "connect ak-1",
    "create from im-built",
    "terminate sb-old",
  ]);
});

it("keeps one connection per token and closes the old one on change", () => {
  const api = createModalApi();
  const first = api.connect(credentials);
  expect(api.connect(credentials)).toBe(first);
  api.connect({ tokenId: "ak-2", tokenSecret: "as-2" });
  api.close();
  expect(calls).toEqual(["connect ak-1", "close", "connect ak-2", "close"]);
});
