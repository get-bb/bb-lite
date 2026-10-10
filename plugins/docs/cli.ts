import { posix } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type CliContext,
  type PluginServerApi,
} from "@bb/plugin";
import { machineFiles } from "@bb/runner";
import { docs } from "./contract.js";

const json = { type: "boolean", description: "Print JSON" } as const;
const vault = {
  type: "string",
  placeholder: "vault-id",
  description: "Vault ID from `bb docs vaults` (default: personal)",
} as const;
const pathArg = [
  {
    name: "path",
    description: "Path relative to the vault root",
    required: true,
  },
] as const;
const version = {
  type: "string",
  placeholder: "n|none",
  description: "Proposal version from `bb docs proposal` (none if null)",
  required: true,
} as const;

const report = (asJson: boolean, value: unknown, text: string) => ({
  exitCode: 0,
  stdout: asJson ? `${JSON.stringify(value)}\n` : `${text}\n`,
});
const parseVersion = (raw: string) => {
  if (raw === "none") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new PluginCliError(`Invalid --version: ${raw}`, { exitCode: 2 });
  return n;
};

export function registerDocsCli(bb: PluginServerApi): void {
  const readCallerFile = (ctx: CliContext, file: string) =>
    bb.runners
      .call(ctx.hostId ?? bb.runners.localHostId, machineFiles.read, {
        path: posix.resolve(ctx.cwd ?? ".", file),
      })
      .then((f) => Buffer.from(f.content, f.contentEncoding).toString("utf8"));

  bb.cli.register(
    defineCli({
      name: "docs",
      summary: "Read, edit, and propose changes to Docs vault documents",
      commands: {
        propose: cliCommand({
          summary: "Propose a complete candidate for approval",
          positionals: pathArg,
          options: {
            vault,
            json,
            file: {
              type: "string",
              placeholder: "path",
              description:
                "Workspace file with the complete candidate Markdown",
              required: true,
            },
            "expected-sha256": {
              type: "string",
              placeholder: "hash",
              description: "Current document SHA-256 from read --json",
              required: true,
            },
            version,
          },
          async run({ options: o, positionals }, ctx) {
            const proposal = await bb.call(docs.propose, {
              vault: o.vault,
              path: positionals.path,
              content: await readCallerFile(ctx, o.file),
              expectedSha256: o["expected-sha256"],
              expectedVersion: parseVersion(o.version),
            });
            const text = `Proposed ${proposal.path} (version ${proposal.version})`;
            return report(o.json, proposal, text);
          },
        }),
        "proposal-update": cliCommand({
          summary: "Edit a pending candidate using its version",
          positionals: pathArg,
          options: {
            vault,
            json,
            version,
            content: {
              type: "string",
              description: "Complete candidate Markdown",
              required: true,
            },
          },
          async run({ options: o, positionals }) {
            const expectedVersion = parseVersion(o.version);
            if (expectedVersion === null)
              throw new PluginCliError(
                "This action requires a proposal version.",
              );
            const proposal = await bb.call(docs.updateProposal, {
              vault: o.vault,
              path: positionals.path,
              content: o.content,
              expectedVersion,
            });
            const text = `Updated ${proposal.path} (version ${proposal.version})`;
            return report(o.json, proposal, text);
          },
        }),
      },
    }),
  );
}
