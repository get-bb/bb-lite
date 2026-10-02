import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MachineEnvironmentList,
  MachineEnvironmentReplace,
  ProjectMachineEnvironmentList,
} from "@bb/server-contract";
import type { ServerContext } from "./context.js";
import type { Db } from "./db/index.js";
import { ApiError } from "./http/errors.js";

interface StoredVariable {
  projectId: string | null;
  name: string;
  ciphertext: string;
  note: string | null;
}

const KEY_FILE = "machine-environment-key";
const KEY_PATTERN = /^[a-f0-9]{64}$/u;
const ENCRYPTION_VERSION = 2;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const GIT_TOKEN_NAME = "GH_TOKEN";

async function encryptionKey(dataDir: string): Promise<Buffer> {
  const path = join(dataDir, KEY_FILE);
  const stored = await readFile(path, "utf8").catch(() => null);
  if (stored === null) {
    const created = randomBytes(32);
    const options = { mode: 0o600, flag: "wx" };
    await writeFile(path, `${created.toString("hex")}\n`, options);
    return created;
  }
  if (!KEY_PATTERN.test(stored.trim())) {
    throw new Error(`${path} is not a machine environment key; restore it.`);
  }
  return Buffer.from(stored.trim(), "hex");
}

function associatedData(variable: Pick<StoredVariable, "projectId" | "name">) {
  return Buffer.from(JSON.stringify([variable.projectId, variable.name]));
}

function encrypt(
  key: Buffer,
  scope: Pick<StoredVariable, "projectId" | "name">,
  value: string,
) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(scope));
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
}

function decrypt(key: Buffer, variable: StoredVariable) {
  try {
    const sealed = Buffer.from(variable.ciphertext, "base64");
    const iv = sealed.subarray(0, IV_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(associatedData(variable));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const body = sealed.subarray(IV_BYTES + TAG_BYTES);
    return decipher.update(body, undefined, "utf8") + decipher.final("utf8");
  } catch {
    throw new Error(
      `Machine environment variable ${variable.name} cannot be decrypted; ` +
        "restore its encryption key or set it again.",
    );
  }
}

function listVariables(db: Db, projectId: string | null) {
  return db.all<StoredVariable>(
    `SELECT project_id, name, ciphertext, note FROM environment_variables
     WHERE project_id IS ? ORDER BY name`,
    projectId,
  );
}

function publicVariables(variables: StoredVariable[]) {
  return variables.map(({ name, note }) => {
    return { name, value: null, secret: true as const, note };
  });
}

export function machineEnvironmentView(db: Db): MachineEnvironmentList {
  const variables = publicVariables(listVariables(db, null));
  const overridden = variables.some(({ name }) => name === GIT_TOKEN_NAME);
  return {
    variables,
    builtInGit: overridden
      ? {
          status: "overridden",
          statusMessage:
            "The built-in gh token is overridden by Machine environment.",
        }
      : {
          status: "disabled",
          statusMessage: "Automatic GitHub credentials are disabled.",
        },
  };
}

export function projectMachineEnvironmentView(
  db: Db,
  projectId: string,
): ProjectMachineEnvironmentList {
  const inherited = machineEnvironmentView(db);
  const variables = publicVariables(listVariables(db, projectId));
  const overridden = variables.some(({ name }) => name === GIT_TOKEN_NAME);
  return {
    builtInGit: overridden
      ? { status: "overridden", statusMessage: "Overridden by this project." }
      : inherited.builtInGit,
    variables,
    inheritedVariables: inherited.variables,
  };
}

export async function replaceMachineEnvironment(
  ctx: ServerContext,
  projectId: string | null,
  input: MachineEnvironmentReplace,
): Promise<void> {
  const { db } = ctx;
  const key = await encryptionKey(ctx.config.dataDir);
  db.transaction(() => {
    const saved = new Map(
      listVariables(db, projectId).map((row) => [row.name, row.ciphertext]),
    );
    db.run(
      "DELETE FROM environment_variables WHERE project_id IS ?",
      projectId,
    );
    for (const { name, value, note } of input.variables) {
      const ciphertext =
        value === null
          ? saved.get(name)
          : encrypt(key, { projectId, name }, value);
      if (ciphertext === undefined) {
        throw new ApiError(
          409,
          "invalid_request",
          `No saved value for ${name}; reload settings and retry`,
        );
      }
      db.run(
        `INSERT INTO environment_variables
           (project_id, name, ciphertext, encryption_version, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        projectId,
        name,
        ciphertext,
        ENCRYPTION_VERSION,
        note,
        db.now(),
      );
    }
  });
}

export async function resolveContributedEnvironment(
  ctx: ServerContext,
  projectId: string | null,
): Promise<Record<string, string>> {
  const variables = [
    ...listVariables(ctx.db, null),
    ...(projectId === null ? [] : listVariables(ctx.db, projectId)),
  ];
  if (variables.length === 0) return {};
  const key = await encryptionKey(ctx.config.dataDir);
  return Object.fromEntries(
    variables.map((variable) => [variable.name, decrypt(key, variable)]),
  );
}
