import path from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type CliContext,
  type PluginServerApi,
} from "@bb/plugin";
import { assertReconcilable, reconcileDotenv } from "./dotenv.js";
import {
  SECRET_REQUEST_RENDERER_ID,
  secretNameSchema,
  secretRequestResponseSchema,
} from "./secret-request.js";

const NAME_RULE = "Names must be unique and match [A-Za-z_][A-Za-z0-9_]*.";

function reject(message: string, code: string): never {
  throw new PluginCliError(message, { code });
}

function isName(value: string | undefined): boolean {
  return secretNameSchema.safeParse(value).success;
}

function foldDescribePairs(argv: readonly string[]): string[] {
  const folded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const [flag = "", name, text] = argv.slice(index, index + 3);
    const pair = flag === "--describe" && isName(name);
    const folds = pair && text !== undefined && !text.startsWith("--");
    folded.push(folds ? `--describe=${name}=${text}` : flag);
    if (folds) index += 2;
  }
  return folded;
}

async function requestSecrets(
  bb: PluginServerApi,
  names: string[],
  options: { "write-env": string; purpose?: string; describe: string[] },
  { threadId, cwd, signal }: CliContext,
) {
  const distinct = new Set(names).size === names.length;
  if (!distinct || !names.every(isName)) reject(NAME_RULE, "invalid_name");
  if (!threadId || !cwd) {
    reject("bb secret request must run from a bb thread.", "missing_thread");
  }
  const descriptions = new Map<string, string>();
  for (const entry of options.describe) {
    const [name = "", text = ""] = entry.split(/=(.*)/su);
    descriptions.set(name.trim(), text.trim());
  }
  const file = { threadId, path: path.resolve(cwd, options["write-env"]) };
  const read = async () =>
    (await bb.files.read(file)) ?? { content: "", sha256: null };
  assertReconcilable((await read()).content, names);
  const listed = names.join(", ");
  const result = await bb.ui.requestInput({
    threadId,
    signal,
    timeoutMs: 10 * 60 * 1000,
    rendererId: SECRET_REQUEST_RENDERER_ID,
    title: "Add secrets",
    payload: {
      purpose: options.purpose?.trim() || null,
      destination: { kind: "dotenv", path: file.path },
      fields: names.map((name) => ({
        name,
        description: descriptions.get(name) || null,
      })),
    },
    presentation: {
      label: {
        pending: `Requesting ${listed}`,
        completed: `Requested ${listed}`,
      },
      icon: { glyph: "Lock" },
    },
    describeSubmission: () => ({
      title: `Provided ${listed}`.slice(0, 160),
      detail: `${file.path}\n- ${names.join("\n- ")}`.slice(0, 280),
    }),
  });
  if (result.outcome === "cancelled") {
    reject(`Secret request cancelled (${result.reason}).`, "cancelled");
  }
  const { data } = secretRequestResponseSchema.safeParse(result.value);
  const provided = Object.keys(data?.values ?? {}).sort();
  if (data === undefined || `${provided}` !== `${[...names].sort()}`) {
    reject("The form did not return exactly the requested names.", "response");
  }
  const current = await read();
  const { content, ...counts } = reconcileDotenv(current.content, data.values);
  const expectedSha256 = current.sha256;
  const target = { ...file, content, expectedSha256, mode: 0o600 };
  if ((await bb.files.write(target)).outcome === "conflict") {
    reject("The dotenv file changed mid-write; run the request again.", "busy");
  }
  const report = { path: file.path, names, ...counts };
  return { exitCode: 0, stdout: `${JSON.stringify(report)}\n` };
}

export default function plugin(bb: PluginServerApi): void {
  const request = cliCommand({
    summary: "Request secrets in a secure user form; values never reach you.",
    positionals: [
      {
        name: "name",
        description: "Environment variable to request; repeat per variable",
        required: true,
        variadic: true,
      },
    ],
    options: {
      "write-env": {
        type: "string",
        required: true,
        description: "Dotenv file to update, relative to the cwd; mode 0600",
      },
      purpose: { type: "string", description: "Why the secrets are needed" },
      describe: {
        type: "string",
        repeatable: true,
        description: "Describe one variable as NAME=TEXT or NAME TEXT",
      },
      json: { type: "boolean", description: "Report failures as JSON" },
    },
    run: ({ positionals, options }, context) =>
      requestSecrets(bb, positionals.name, options, context),
  });
  const summary = "Request credentials from the user into a dotenv file.";
  const cli = defineCli({ name: "secret", summary, commands: { request } });
  const run: typeof cli.run = (argv, context) =>
    cli.run(foldDescribePairs(argv), context);
  bb.cli.register({ ...cli, run });
}
