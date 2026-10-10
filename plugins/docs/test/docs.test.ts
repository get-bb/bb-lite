import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAs } from "../../../packages/server-kit/src/auth/actor.js";
import { expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";
import { insertRow } from "../../../packages/server-kit/src/db/index.js";
import { docs } from "../contract.js";

type Row = Record<string, unknown>;

async function docsServer() {
  const server = await createTestServer({}, "workspace");
  const send = async (url: string, body: unknown) => {
    const response = await fetch(`${server.url}/api/v1${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Row;
    return { ok: response.ok, status: response.status, body: result };
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
  return { op, cli, send, root, work, server };
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
  expect(conflict.exitCode).toBe(3);
  expect(JSON.parse(conflict.stdout)).toMatchObject({ outcome: "conflict" });
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

it("reports a vault-side change as a conflict and pushes nothing", async () => {
  const { cli, root, work } = await docsServer();
  writeFileSync(join(root, "a.md"), "one\n");
  writeFileSync(join(root, "b.md"), "bee\n");
  writeFileSync(join(root, "c.md"), "sea\n");
  expect((await cli("pull --all --vault team --into out")).exitCode).toBe(0);
  writeFileSync(join(work, "out/a.md"), "mine\n");
  writeFileSync(join(work, "out/b.md"), "bee two\n");
  writeFileSync(join(root, "a.md"), "theirs\n");
  writeFileSync(join(root, "c.md"), "sea two\n");
  const status = await cli("status out --json");
  expect(status.exitCode).toBe(3);
  expect(JSON.parse(status.stdout)).toEqual({
    outcome: "conflict",
    changes: [{ path: "b.md", status: "modified" }],
    conflicts: [
      { path: "a.md", reason: "both local and vault copies changed" },
      { path: "c.md", reason: "vault file changed after pull" },
    ],
  });
  const push = await cli("push out");
  expect(push.exitCode).toBe(3);
  expect(push.stdout).toContain("conflict\ta.md");
  expect(readFileSync(join(root, "a.md"), "utf8")).toBe("theirs\n");
  expect(readFileSync(join(root, "b.md"), "utf8")).toBe("bee\n");
  writeFileSync(join(root, "a.md"), "one\n");
  writeFileSync(join(root, "c.md"), "sea\n");
  const pushed = await cli("push out --json");
  expect(pushed.exitCode).toBe(0);
  expect(JSON.parse(pushed.stdout)).toMatchObject({ outcome: "pushed" });
  expect(readFileSync(join(root, "b.md"), "utf8")).toBe("bee two\n");
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
  const { op, send, root } = await docsServer();
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
  writeFileSync(join(root, "a.md"), "a\n");
  writeFileSync(join(root, "b.md"), "b\n");
  for (const path of ["a.md", "b.md", "./a.md"])
    await op("visit", { threadId: "thr_1", vault: "team", path });
  const visit = async (vault: string, path: string) => {
    const input = { threadId: "thr_1", vault, path };
    const { status, body } = await send("/ops/docs.visit", input);
    return [status, body.code];
  };
  expect(await visit("nope", "a.md")).toEqual([404, "unknown_vault"]);
  expect((await visit("team", "missing.md"))[0]).toBe(404);
  expect((await visit("team", "../a.md"))[0]).toBe(400);
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
  }, 10_000);
  expect(signal).toMatchObject({ type: "plugin-signal" });
}, 15_000);

it("creates the Personal vault folder and lists every command in help", async () => {
  const { cli, op } = await docsServer();
  const vaults = await op<Row[]>("vaults");
  const personal = vaults.find((v) => v.vaultId === "personal");
  expect(existsSync(String(personal?.rootPath))).toBe(true);
  const help = await cli("--help");
  expect(help.exitCode).toBe(0);
  for (const command of ["propose", "list", "read", "pull", "push", "status"])
    expect(help.stdout).toContain(`bb docs ${command} `);
});

it("refuses a member vault changes on a machine that is not shared with them", async () => {
  const { server, root } = await docsServer();
  const { db, kernel } = server.ctx;
  const at = { createdAt: 1, updatedAt: 1 };
  const bo = { id: "usr_bo", name: "Bo", role: "member", externalId: "ext_bo" };
  insertRow(db, "users", { ...bo, ...at });
  const member = {
    userId: bo.id,
    role: "member" as const,
    agentThreadId: null,
  };
  const notShared = { body: { code: "machine_not_shared" } };
  const vault = { name: "Mine", absoluteRoot: root };
  const create = runAs(member, () => kernel.call(docs.createVault, vault));
  await expect(create).rejects.toMatchObject(notShared);
  const personal = { vaultId: "personal" };
  const remove = runAs(member, () => kernel.call(docs.deleteVault, personal));
  await expect(remove).rejects.toMatchObject(notShared);
});
