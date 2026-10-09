import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const cli = async (line: string) => {
    const argv = line.split(" ");
    const { body } = await send("/plugins/docs/cli", { argv, cwd: work });
    return body as { exitCode: number; stdout: string; stderr: string };
  };
  await op("createVault", { name: "Team", absoluteRoot: root });
  return { op, cli, root, work };
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
  const conflict = await cli("push out");
  expect(conflict.exitCode).not.toBe(0);
  expect(readFileSync(join(root, "a.md"), "utf8")).toBe("theirs\n");
  writeFileSync(join(root, "a.md"), "one\n");
  expect((await cli("push out")).exitCode).toBe(0);
  expect(readFileSync(join(root, "a.md"), "utf8")).toBe("two\n");
  expect((await cli("status out")).exitCode).toBe(0);
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
