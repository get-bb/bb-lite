import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";

type Row = Record<string, unknown>;

async function docsServer() {
  const server = await createTestServer({}, "workspace");
  const send = async (url: string, body: unknown) => {
    const response = await fetch(`${server.url}/api/v1${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, body: (await response.json()) as Row };
  };
  const op = async <T = Row>(name: string, input: Row = {}): Promise<T> => {
    const { ok, body } = await send(`/ops/docs.${name}`, input);
    if (!ok) throw new Error(String(body.message));
    return body.result as T;
  };
  const root = mkdtempSync(join(tmpdir(), "docs-vault-"));
  const work = mkdtempSync(join(tmpdir(), "docs-work-"));
  const cli = async (line: string, scope: Row = {}) => {
    const argv = line.split(" ");
    const input = { argv, cwd: work, ...scope };
    const { body } = await send("/plugins/docs/cli", input);
    return body as { exitCode: number; stdout: string; stderr: string };
  };
  await op("createVault", { name: "Team", absoluteRoot: root });
  return { op, cli, root, work, server };
}

it("lists vaults, writes, reads and lists documents through the CLI", async () => {
  const { cli, root } = await docsServer();
  const vaults = JSON.parse((await cli("vaults --json")).stdout) as Row[];
  expect(vaults.map((v) => v.vaultId)).toEqual(["personal", "team"]);
  writeFileSync(join(root, "plan.md"), "# Plan\n");
  expect((await cli("read plan.md --vault team")).stdout).toBe("# Plan\n");
  expect((await cli("mkdir notes --vault team")).exitCode).toBe(0);
  expect(
    (await cli("write notes/a.md --content hi --vault team")).exitCode,
  ).toBe(0);
  const listed = (await cli("list --vault team")).stdout;
  expect(listed).toContain("file\tplan.md");
  expect(listed).toContain("directory\tnotes\nfile\tnotes/a.md");
  expect((await cli("read ../x --vault team")).exitCode).not.toBe(0);
});

it("pulls, reports status and pushes with version checks", async () => {
  const { cli, root, work } = await docsServer();
  writeFileSync(join(root, "a.md"), "one\n");
  expect((await cli("pull --all --vault team --into out")).exitCode).toBe(0);
  expect(readFileSync(join(work, "out/a.md"), "utf8")).toBe("one\n");
  expect((await cli("status out")).exitCode).toBe(0);
  writeFileSync(join(work, "out/a.md"), "two\n");
  const status = await cli("status out --diff");
  expect(status.exitCode).toBe(4);
  expect(status.stdout).toContain("+two");
  writeFileSync(join(root, "a.md"), "theirs\n");
  const conflict = await cli("push out --json");
  expect(conflict.exitCode).not.toBe(0);
  expect(conflict.stdout + conflict.stderr).toContain("document_changed");
  expect(readFileSync(join(root, "a.md"), "utf8")).toBe("theirs\n");
  writeFileSync(join(root, "a.md"), "one\n");
  expect((await cli("push out")).exitCode).toBe(0);
  expect(readFileSync(join(root, "a.md"), "utf8")).toBe("two\n");
  expect((await cli("status out")).exitCode).toBe(0);
  expect((await cli("pull --vault team --into out")).exitCode).not.toBe(0);
  const elsewhere = await cli("pull --all --vault team --into far", {
    hostId: "host_elsewhere",
  });
  expect(elsewhere.exitCode).not.toBe(0);
  expect(existsSync(join(work, "far"))).toBe(false);
  const missing = await cli("status nowhere --json");
  expect(missing.exitCode).not.toBe(0);
  writeFileSync(join(work, "out/b.md"), "new\n");
  const dry = await cli("push out --dry-run --json");
  expect(JSON.parse(dry.stdout)).toMatchObject({
    changes: [{ path: "b.md", status: "added" }],
    dryRun: true,
  });
});

it("proposes a change and accepts, undoes and redoes it", async () => {
  const { op, cli, root, work } = await docsServer();
  writeFileSync(join(root, "letter.md"), "Dear Bob\n");
  writeFileSync(join(work, "candidate.md"), "Dear Alice\n");
  const file = await op<{ sha256: string }>("read", {
    vault: "team",
    path: "letter.md",
  });
  const flags = `--vault team --file candidate.md --expected-sha256 ${file.sha256}`;
  const proposed = await cli(
    `propose letter.md ${flags} --version none --json`,
  );
  expect(JSON.parse(proposed.stdout)).toMatchObject({ version: 1 });
  expect(
    (await cli(`propose letter.md ${flags} --version none`)).exitCode,
  ).not.toBe(0);
  expect(readFileSync(join(root, "letter.md"), "utf8")).toBe("Dear Bob\n");
  const at = { vault: "team", path: "letter.md" };
  await op("resolveProposal", { ...at, action: "accept", expectedVersion: 1 });
  expect(readFileSync(join(root, "letter.md"), "utf8")).toBe("Dear Alice\n");
  await op("resolveProposal", { ...at, action: "undo", expectedVersion: 2 });
  expect(readFileSync(join(root, "letter.md"), "utf8")).toBe("Dear Bob\n");
  const redone = await op("resolveProposal", {
    ...at,
    action: "redo",
    expectedVersion: 3,
  });
  expect(redone).toMatchObject({ status: "accepted", version: 4 });
  expect(readFileSync(join(root, "letter.md"), "utf8")).toBe("Dear Alice\n");
});

it("renames to the title, uploads attachments, keeps order and recent documents", async () => {
  const { op, root } = await docsServer();
  writeFileSync(join(root, "untitled.md"), "# Launch Plan\n\nBody\n");
  const team = { vault: "team" };
  const renamed = await op("renameToTitle", { ...team, path: "untitled.md" });
  expect(renamed).toEqual({ path: "Launch Plan.md" });
  expect(readFileSync(join(root, "Launch Plan.md"), "utf8")).toContain("Body");
  const upload = await op("uploadAttachment", {
    ...team,
    path: "Launch Plan.md",
    name: "chart.png",
    contentBase64: Buffer.from("png").toString("base64"),
  });
  expect(upload).toEqual({
    path: "attachments/chart.png",
    markdown: "![chart.png](attachments/chart.png)",
  });
  expect(readFileSync(join(root, "attachments/chart.png"), "utf8")).toBe("png");
  await op("reorder", { ...team, folder: "", names: ["b.md", "a.md"] });
  expect(await op("order", { ...team, folder: "" })).toEqual(["b.md", "a.md"]);
  for (const path of ["a.md", "b.md", "a.md"])
    await op("visit", { threadId: "thr_1", vault: "team", path });
  expect(await op("recent", { threadId: "thr_1" })).toEqual([
    { vault: "team", path: "a.md" },
    { vault: "team", path: "b.md" },
  ]);
  await expect(
    op("renameToTitle", { ...team, path: "attachments/chart.png" }),
  ).rejects.toThrow(/no "# Title"/u);
});

it("refreshes the app when a document changes on disk", async () => {
  const { op, root, server } = await docsServer();
  writeFileSync(join(root, "live.md"), "one\n");
  await op("read", { vault: "team", path: "live.md" });
  const socket = await server.socket();
  writeFileSync(join(root, "live.md"), "two\n");
  const signal = await socket.next((message: Row) => {
    const payload = message.payload as Row | undefined;
    return message.type === "plugin-signal" && payload?.name === "docs.read";
  });
  expect(signal).toBeTruthy();
}, 15_000);
