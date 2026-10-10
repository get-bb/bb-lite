import { expect, it } from "vitest";
import { FILE_PAYLOAD_MAX_BYTES, RunnerError } from "@bb/runner";
import { MAX_PREVIEW_BYTES } from "../server.js";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";

type Body = Record<string, unknown>;

async function inlineVisServer() {
  const server = await createThreadServer();
  const reads: Body[] = [];
  const disk: Record<string, string> = {
    "/repo/charts/out.html": "<h1>chart</h1>",
    "/repo/notes.md": "# Notes",
  };
  Object.assign(server.runner.script, {
    readFile: async (input: { path: string; rootPath?: string }) => {
      reads.push(input);
      const absolute = input.path.startsWith("/")
        ? input.path
        : `${input.rootPath}/${input.path}`;
      const content = disk[absolute];
      if (content === undefined) {
        throw new RunnerError("path_not_found", "missing");
      }
      if (content.length > FILE_PAYLOAD_MAX_BYTES) {
        throw new RunnerError("file_too_large", "read it in chunks");
      }
      return {
        path: absolute,
        content,
        contentEncoding: "utf8",
        sizeBytes: content.length,
        sha256: "x",
      };
    },
  });
  Object.assign(server.runner.script, {
    readFileChunk: async (input: {
      path: string;
      rootPath?: string;
      offset: number;
      length: number;
    }) => {
      const content = disk[`${input.rootPath}/${input.path}`] ?? "";
      const end = input.offset + input.length;
      const bytes = Buffer.from(content).subarray(input.offset, end);
      return {
        sizeBytes: content.length,
        revision: "r",
        dataBase64: bytes.toString("base64"),
      };
    },
  });
  const threadId = await server.spawn();
  const preview = (input: Body) =>
    server.http<Body>("POST", "/ops/inline-vis.preview", {
      threadId,
      ...input,
    });
  return { ...server, threadId, reads, disk, preview };
}

it("prepares workspace HTML and Markdown previews", async () => {
  const { preview, threadId, reads } = await inlineVisServer();
  const html = await preview({ file: "charts/out.html" });
  expect(html.status).toBe(200);
  expect(html.body.result).toMatchObject({
    kind: "html",
    file: "charts/out.html",
    source: "workspace",
    url: expect.stringMatching(
      /^\/api\/v1\/environments\/.+\/files\/charts\/out\.html$/,
    ),
  });
  expect(reads).toContainEqual(
    expect.objectContaining({ path: "charts/out.html", rootPath: "/repo" }),
  );
  const markdown = await preview({ file: "./notes.md" });
  expect(markdown.body.result).toMatchObject({
    kind: "markdown",
    file: "notes.md",
    content: "# Notes",
  });
  expect(threadId).toBeTruthy();
});

it("previews files larger than one runner read, up to the preview limit", async () => {
  const { preview, disk } = await inlineVisServer();
  const large = "# Big\n".padEnd(FILE_PAYLOAD_MAX_BYTES * 2 + 7, "x");
  disk["/repo/big.md"] = large;
  disk["/repo/big.html"] = large;
  disk["/repo/huge.html"] = "x".repeat(MAX_PREVIEW_BYTES + 1);
  const markdown = await preview({ file: "big.md" });
  expect(markdown.body.result).toMatchObject({ content: large });
  const html = await preview({ file: "big.html" });
  expect(html.body.result).toMatchObject({ kind: "html", file: "big.html" });
  const huge = await preview({ file: "huge.html" });
  expect(huge.status).toBe(400);
  expect(JSON.stringify(huge.body)).toContain("Preview file is too large");
});

it("reports a missing file and refuses unsafe paths", async () => {
  const { preview } = await inlineVisServer();
  expect((await preview({ file: "gone.html" })).body.result).toEqual({
    kind: "not-found",
    file: "gone.html",
  });
  for (const file of ["../secret.html", "/etc/x.html", "notes.txt"]) {
    const refused = await preview({ file });
    expect(refused.status).toBe(400);
  }
  expect((await preview({ file: "a.html", source: "disk" })).status).toBe(400);
});

it("prepares a thread-storage preview from its absolute path", async () => {
  const server = await inlineVisServer();
  const [host] = server.rows<{ root: string }>(
    "SELECT thread_storage_root AS root FROM hosts",
  );
  const absolute = `${host!.root}/${server.threadId}/reports/r.html`;
  server.disk[absolute] = "<p>report</p>";
  const { body } = await server.preview({
    source: "thread-storage",
    file: "reports/r.html",
  });
  expect(body.result).toEqual({
    kind: "html",
    file: "reports/r.html",
    source: "thread-storage",
    url: `/api/v1/threads/${server.threadId}/host-files${absolute}`,
  });
});
