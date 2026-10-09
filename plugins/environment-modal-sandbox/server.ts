import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join, resolve } from "node:path";
import {
  environments,
  machines,
  terminals,
  threads,
  type EnvironmentContext,
  type PluginServerApi,
} from "@bb/plugin";
import { z } from "zod";
import {
  dockerfileSchema,
  launchOptionsSchema,
  machineInputsSchema,
  modal,
  modalImageSchema,
  sandboxPresetSchema,
  type LaunchOptions,
} from "./contract.js";
import type { ModalClient } from "./modal-api.js";
import { createModalApi } from "./modal-client.js";

export const PROVIDER_ID = "modal-sandbox";
const HOME = "/home/node";
const SANDBOX_LIFETIME_MS = 24 * 60 * 60_000;
const DEFAULT_SIZE = { cpu: 1, memoryMiB: 2048 };
const MAX_IDLE_MINUTES = 24 * 60;
const DOCKERFILE_KEY = "dockerfile-override";
const PRESETS_KEY = "sandbox-size-presets";
const IMAGES_KEY = "named-images";
const RETRY_LIMIT = 3;
const RETRY_MS = 1_000;
const DEBUG_LIFETIME_MS = 30 * 60_000;
const allocationSchema = z.object({
  accountIdentity: z.string(),
  appName: z.string(),
  key: z.string(),
});
const debugSchema = z.object({
  accountIdentity: z.string(),
  appName: z.string(),
  key: z.string(),
});

const SETTINGS = {
  tokenId: {
    type: "string",
    secret: true,
    label: "Modal token id",
    description:
      "The token id half of a Modal API token (modal token new writes one to ~/.modal.toml).",
  },
  tokenSecret: {
    type: "string",
    label: "Modal token secret",
    secret: true,
    description: "The token secret half of the same Modal API token.",
  },
  appName: {
    type: "string",
    label: "Modal app name",
    description: "The Modal app the sandboxes are created in.",
    default: "bb-sandboxes",
  },
  idleMinutes: {
    type: "number",
    label: "Hibernate after idle (minutes)",
    description:
      "Snapshot and stop an idle sandbox after this long. Use 0 to keep it running until Modal's 24-hour sandbox limit.",
    default: 15,
  },
} as const;

const resourceSchema = z.object({
  key: z.string().min(1),
  sandboxId: z.string().min(1).nullable(),
  snapshotImageId: z.string().min(1).nullable(),
  imageId: z.string().min(1),
  accountIdentity: z.string().min(1),
  appName: z.string().min(1),
  cpu: z.number().positive(),
  memoryMiB: z.number().positive(),
});
type Resource = z.infer<typeof resourceSchema>;

interface Resolved {
  tokenId: string;
  tokenSecret: string;
  appName: string;
  idleMs: number | null;
}

export function resolveSettings(raw: {
  tokenId?: string;
  tokenSecret?: string;
  appName?: string;
  idleMinutes?: number;
}): { ok: true; settings: Resolved } | { ok: false; message: string } {
  const tokenId = (raw.tokenId ?? "").trim();
  const tokenSecret = (raw.tokenSecret ?? "").trim();
  const missing = [
    ...(tokenId === "" ? ["tokenId"] : []),
    ...(tokenSecret === "" ? ["tokenSecret"] : []),
  ];
  if (missing.length > 0) {
    const message = `Set ${missing.join(" and ")} in the plugin's settings.`;
    return { ok: false, message };
  }
  const appName = (raw.appName ?? "bb-sandboxes").trim();
  if (appName === "") {
    return { ok: false, message: "The app name must not be blank." };
  }
  const idle = raw.idleMinutes ?? 15;
  if (!Number.isInteger(idle) || idle < 0 || idle > MAX_IDLE_MINUTES) {
    const message = `idleMinutes must be a whole number between 0 and ${MAX_IDLE_MINUTES}, not ${idle}.`;
    return { ok: false, message };
  }
  const idleMs = idle === 0 ? null : idle * 60_000;
  return { ok: true, settings: { tokenId, tokenSecret, appName, idleMs } };
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export default async function modalSandbox(bb: PluginServerApi): Promise<void> {
  const settings = bb.settings.define(SETTINGS);
  const kv = bb.storage.kv;
  const realApi = createModalApi();
  bb.add(modal.api, realApi);
  bb.onDispose(realApi.close);

  async function retry<T>(
    attempt: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    for (let count = 1; ; count += 1) {
      try {
        return await attempt();
      } catch (error) {
        signal.throwIfAborted();
        if (count >= RETRY_LIMIT) throw error;
        await sleep(RETRY_MS * count, undefined, { signal });
      }
    }
  }

  async function requireSettings(): Promise<Resolved> {
    const resolved = resolveSettings(await settings.get());
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.settings;
  }

  async function client(): Promise<{ api: ModalClient; settings: Resolved }> {
    const resolved = await requireSettings();
    const api = bb.pick(modal.api);
    if (api === null) {
      throw new Error("No Modal client is available in this build of bb.");
    }
    return { api: api.connect(resolved), settings: resolved };
  }

  async function standardDockerfile(): Promise<string> {
    return readFile(new URL("./Dockerfile", import.meta.url), "utf8");
  }

  async function imageDefinition() {
    const stored = await kv.get<unknown>(DOCKERFILE_KEY);
    return stored === undefined
      ? { dockerfile: await standardDockerfile(), customized: false }
      : { dockerfile: dockerfileSchema.parse(stored), customized: true };
  }

  async function launchOptions(): Promise<LaunchOptions> {
    const presets = z
      .array(sandboxPresetSchema)
      .parse((await kv.get<unknown>(PRESETS_KEY)) ?? []);
    const extra = z
      .array(modalImageSchema)
      .parse((await kv.get<unknown>(IMAGES_KEY)) ?? []);
    const { dockerfile } = await imageDefinition();
    const standard = { name: "Default", source: "dockerfile" as const };
    return { presets, images: [{ ...standard, dockerfile }, ...extra] };
  }

  function requireUnique(kind: string, entries: { name: string }[]) {
    const names = entries.map((entry) => entry.name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) {
      throw new Error(`${kind} names must be unique.`);
    }
  }

  async function selection(value: unknown) {
    const inputs = machineInputsSchema.parse(value ?? {});
    const options = await launchOptions();
    const preset =
      inputs.preset === undefined
        ? (options.presets[0] ?? null)
        : options.presets.find((entry) => entry.name === inputs.preset);
    if (preset === undefined) {
      throw new Error(`There is no sandbox size named ${inputs.preset}.`);
    }
    const image =
      inputs.image === undefined
        ? options.images[0]
        : options.images.find((entry) => entry.name === inputs.image);
    if (image === undefined) {
      throw new Error(`There is no Modal image named ${inputs.image}.`);
    }
    return { preset, image };
  }

  const allocationKey = (sandboxId: string) => `allocations/${sandboxId}`;

  async function track(
    sandboxId: string,
    owner: z.infer<typeof allocationSchema>,
  ) {
    const { accountIdentity, appName, key } = owner;
    await kv.set(allocationKey(sandboxId), { accountIdentity, appName, key });
  }

  async function reconcile(owner: Resource | null, ownedKeys: Set<string>) {
    const keys = await kv.list("allocations/");
    if (keys.length === 0) return;
    const { api } = await client();
    const accountIdentity = await api.accountIdentity();
    for (const entry of keys) {
      const sandboxId = entry.slice("allocations/".length);
      const allocation = allocationSchema.parse(await kv.get<unknown>(entry));
      if (allocation.accountIdentity !== accountIdentity) continue;
      if (owner === null && ownedKeys.has(allocation.key)) continue;
      if (owner !== null && allocation.key !== owner.key) continue;
      if (!(await api.running(sandboxId))) {
        await kv.delete(entry);
        continue;
      }
      if (owner?.sandboxId === sandboxId) continue;
      if (owner === null || owner.snapshotImageId === null) {
        bb.log.warn(
          `Tracked Modal sandbox ${sandboxId} has no matching machine; retaining it for inspection`,
        );
        continue;
      }
      await api.terminate(sandboxId);
      await kv.delete(entry);
    }
  }

  async function sweepAllocations() {
    const ownedKeys = new Set<string>();
    for (const host of await bb.call(machines.list, {})) {
      if (host.machineProviderId !== PROVIDER_ID) continue;
      const resource = await storedResource(host.id);
      if (resource === null) continue;
      ownedKeys.add(resource.key);
      await bb.call(machines.reconcile, { hostId: host.id });
    }
    await reconcile(null, ownedKeys);
  }
  const idleKey = (hostId: string) => `idle/${hostId}`;

  async function saveResource(hostId: string, resource: Resource) {
    await bb.call(machines.update, { hostId, resource });
  }

  async function storedResource(hostId: string): Promise<Resource | null> {
    const stored = await bb
      .call(machines.resource, { hostId })
      .catch(() => null);
    const parsed = resourceSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
  }

  async function run(api: ModalClient, sandboxId: string, script: string) {
    const result = await api.exec(sandboxId, ["sh", "-lc", script]);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(`Sandbox command failed (${result.exitCode}): ${detail}`);
    }
    return result.stdout;
  }

  async function startRunner(
    api: ModalClient,
    sandboxId: string,
    hostId: string,
    command: string,
  ) {
    await run(api, sandboxId, `nohup ${command} >/tmp/bb-runner.log 2>&1 &`);
    const connected = await bb.call(machines.waitConnected, { hostId });
    if (!connected) {
      throw new Error("The bb runner in the Modal sandbox did not connect.");
    }
    await kv.set(idleKey(hostId), bb.now());
  }

  async function checkout(
    api: ModalClient,
    sandboxId: string,
    context: EnvironmentContext,
  ): Promise<string> {
    const remote = context.project.gitRemoteUrl;
    const slug = context.project.name.replace(/[^\w.-]+/gu, "-") || "project";
    const home = (await run(api, sandboxId, 'printf %s "$HOME"')).trim();
    const path = join(home || HOME, remote === null ? "workspace" : slug);
    if (remote === null) {
      await run(api, sandboxId, `mkdir -p ${quote(path)}`);
      return path;
    }
    context.report("Cloning the project into the sandbox");
    const branch = quote(context.branchName);
    await run(
      api,
      sandboxId,
      `git clone ${quote(remote)} ${quote(path)} && cd ${quote(path)} && ` +
        `(git checkout ${branch} 2>/dev/null || git checkout -b ${branch})`,
    );
    return path;
  }

  async function create(context: EnvironmentContext) {
    const { api, settings: resolved } = await client();
    const { preset, image } = await selection(context.inputs);
    const { signal } = context;
    const accountIdentity = await retry(() => api.accountIdentity(), signal);
    const step = { key: "modal-image" };
    context.report(`Preparing the ${image.name} Modal image`, "started", step);
    const imageId =
      image.source === "image-id"
        ? image.imageId
        : await retry(
            () =>
              api.ensureImage({
                appName: resolved.appName,
                dockerfile: image.dockerfile,
                signal,
                log: (line) => {
                  const text = line.trim();
                  if (text) context.log(text);
                },
              }),
            signal,
          );
    context.report(`${image.name} Modal image ready`, "completed", step);
    signal.throwIfAborted();
    context.report("Creating the sandbox");
    const key = `bb-${context.thread.id}`;
    const size = preset ?? DEFAULT_SIZE;
    const sandboxId = await retry(
      () =>
        api.create({
          appName: resolved.appName,
          name: key,
          imageId,
          timeoutMs: SANDBOX_LIFETIME_MS,
          cpu: size.cpu,
          memoryMiB: size.memoryMiB,
          tags: { bbMachineKey: key },
        }),
      signal,
    );
    await track(sandboxId, { accountIdentity, appName: resolved.appName, key });
    const resource: Resource = {
      key,
      sandboxId,
      snapshotImageId: null,
      imageId,
      accountIdentity,
      appName: resolved.appName,
      cpu: size.cpu,
      memoryMiB: size.memoryMiB,
    };
    let hostId: string | null = null;
    try {
      const enrolled = await bb.call(machines.enroll, {
        name: `Modal sandbox ${sandboxId.replace(/[^a-z0-9]/giu, "").slice(-6)}`,
        providerId: PROVIDER_ID,
        resource,
      });
      hostId = enrolled.hostId;
      context.report("Starting the bb runner in the sandbox");
      await startRunner(api, sandboxId, hostId, enrolled.command);
      const path = await checkout(api, sandboxId, context);
      return { path, hostId, resource };
    } catch (error) {
      await api.terminate(sandboxId);
      if (hostId !== null) await bb.call(machines.delete, { hostId });
      throw error;
    }
  }

  async function release(hostId: string, resource: unknown) {
    const current =
      (await storedResource(hostId)) ?? resourceSchema.parse(resource);
    const { api } = await client();
    if (current.sandboxId !== null) await api.terminate(current.sandboxId);
    if (current.snapshotImageId !== null) {
      await api.deleteSnapshot(current.snapshotImageId);
    }
    await kv.delete(idleKey(hostId));
  }

  bb.add(machines.provider, {
    id: PROVIDER_ID,
    displayName: "Modal Sandbox",
    async suspend({ hostId, resource }) {
      const current = resourceSchema.parse(resource);
      if (current.sandboxId === null) return;
      const { api } = await client();
      const snapshotImageId = await api.snapshot(current.sandboxId);
      await api.terminate(current.sandboxId);
      const previous = current.snapshotImageId;
      await saveResource(hostId, {
        ...current,
        sandboxId: null,
        snapshotImageId,
      });
      if (previous !== null && previous !== snapshotImageId) {
        await api.deleteSnapshot(previous);
      }
    },
    async resume({ hostId, resource }) {
      const current = resourceSchema.parse(resource);
      const { api } = await client();
      if (current.sandboxId !== null && (await api.running(current.sandboxId)))
        return;
      if (current.snapshotImageId === null) {
        throw new Error("This Modal machine has no snapshot to restore.");
      }
      const sandboxId = await api.create({
        appName: current.appName,
        name: current.key,
        imageId: current.snapshotImageId,
        timeoutMs: SANDBOX_LIFETIME_MS,
        cpu: current.cpu,
        memoryMiB: current.memoryMiB,
        tags: { bbMachineKey: current.key },
      });
      await track(sandboxId, current);
      await saveResource(hostId, { ...current, sandboxId });
      const { command } = await bb.call(machines.createReconnectCommand, {
        hostId,
      });
      await startRunner(api, sandboxId, hostId, command);
    },
    delete: ({ hostId, resource }) => release(hostId, resource),
    reconcile: ({ resource }) =>
      reconcile(resourceSchema.parse(resource), new Set()),
  });

  bb.add(environments.kind, {
    id: PROVIDER_ID,
    displayName: "Modal Sandbox",
    description: "Create a project checkout in a new Modal sandbox.",
    icon: "./modal-logo.svg",
    inputs: {},
    async validate(inputs) {
      const resolved = resolveSettings(await settings.get());
      if (!resolved.ok) return resolved.message;
      try {
        await selection(inputs);
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
    create,
    async delete({ hostId, resource }) {
      await release(hostId, resource);
      await bb.call(machines.delete, { hostId });
    },
  });

  async function ownedActive(hostId: string): Promise<boolean> {
    const host = await bb.call(machines.get, { hostId });
    return (
      host.machineProviderId === PROVIDER_ID &&
      host.lifecycle.phase === "active"
    );
  }

  const threadHosts = new Map<string, string | null>();
  async function hostOfThread(threadId: string): Promise<string | null> {
    const known = threadHosts.get(threadId);
    if (known !== undefined) return known;
    const thread = await bb.call(threads.get, { threadId });
    const hostId =
      thread.environmentId === null
        ? null
        : (
            await bb.call(environments.get, {
              environmentId: thread.environmentId,
            })
          ).hostId;
    threadHosts.set(threadId, hostId);
    return hostId;
  }

  async function bump(hostId: string | null) {
    if (hostId !== null && (await ownedActive(hostId))) {
      await kv.set(idleKey(hostId), bb.now());
    }
  }
  bb.on(threads.appended, async ({ threadId }) =>
    bump(await hostOfThread(threadId)),
  );
  bb.on(terminals.inputReceived, ({ hostId }) => bump(hostId));

  bb.background.schedule("pause-idle-machines", "* * * * *", async () => {
    const resolved = resolveSettings(await settings.get());
    if (!resolved.ok) return;
    await sweepAllocations().catch((error) => {
      bb.log.warn(`Modal allocation sweep failed: ${errorMessage(error)}`);
    });
    if (resolved.settings.idleMs === null) return;
    const idleMs = resolved.settings.idleMs;
    for (const host of await bb.call(machines.list, {})) {
      if (host.machineProviderId !== PROVIDER_ID) continue;
      if (host.lifecycle.phase !== "active") continue;
      const last = z
        .number()
        .optional()
        .parse(await kv.get<unknown>(idleKey(host.id)));
      if (last === undefined) {
        await kv.set(idleKey(host.id), bb.now());
        continue;
      }
      if (bb.now() < last + idleMs) continue;
      await bb.call(machines.suspend, { hostId: host.id }).catch((error) => {
        bb.log.warn(`Idle pause failed for ${host.id}: ${errorMessage(error)}`);
      });
    }
  });

  bb.implement(modal.account, async () => {
    try {
      const { api, settings: resolved } = await client();
      await api.accountIdentity();
      const message = `Connected to Modal (${resolved.appName})`;
      return { available: true, message };
    } catch (error) {
      return { available: false, message: errorMessage(error) };
    }
  });

  bb.implement(modal.machine, async ({ hostId }) => {
    const resource = await storedResource(hostId);
    if (resource === null) {
      throw new Error("No provider resource for this machine.");
    }
    const { api } = await client();
    const running =
      resource.sandboxId !== null && (await api.running(resource.sandboxId));
    const summary = [
      `Sandbox: ${resource.sandboxId ?? "none"} (${running ? "running" : "stopped"})`,
      `Size: ${resource.cpu} CPU, ${resource.memoryMiB} MiB`,
      `Image: ${resource.imageId}`,
      `Snapshot: ${resource.snapshotImageId ?? "none"}`,
    ].join("\n");
    return { summary, resource };
  });

  bb.implement(modal.image, imageDefinition);
  bb.implement(modal.updateImage, async ({ file }) => {
    const dockerfile = dockerfileSchema.parse(
      await readFile(resolve(file), "utf8"),
    );
    await kv.set(DOCKERFILE_KEY, dockerfile);
    return { dockerfile, customized: true };
  });
  bb.implement(modal.deleteImage, async () => {
    await kv.delete(DOCKERFILE_KEY);
    return imageDefinition();
  });

  bb.implement(modal.launchOptions, launchOptions);
  bb.implement(modal.updateLaunchOptions, async (value) => {
    const parsed = launchOptionsSchema.parse(value);
    const [standard, ...extra] = parsed.images;
    if (standard?.name !== "Default" || standard.source !== "dockerfile") {
      throw new Error(
        'The first image must be the bundled "Default" Dockerfile.',
      );
    }
    requireUnique("Preset", parsed.presets);
    requireUnique("Image", parsed.images);
    await kv.set(PRESETS_KEY, parsed.presets);
    await kv.set(IMAGES_KEY, extra);
    return launchOptions();
  });

  async function buildImage(signal: AbortSignal) {
    const { api, settings: resolved } = await client();
    let logs = "";
    const log = (line: string) => {
      logs = `${logs}${line}\n`.slice(-65_536);
    };
    try {
      const { dockerfile } = await imageDefinition();
      const imageId = await api.ensureImage({
        appName: resolved.appName,
        dockerfile,
        signal,
        log,
      });
      return { api, resolved, imageId, logs };
    } catch (error) {
      throw new Error(`${logs}${errorMessage(error)}`);
    }
  }

  async function debugSandbox(sandboxId: string) {
    const stored = await kv.get<unknown>(`debug/${sandboxId}`);
    if (stored === undefined) {
      throw new Error(
        "Unknown debug sandbox; use an ID returned by bb modal sandbox run",
      );
    }
    const record = debugSchema.parse(stored);
    const { api } = await client();
    if (record.accountIdentity !== (await api.accountIdentity())) {
      throw new Error(
        "Restore the Modal account that created this debug sandbox",
      );
    }
    return { api, running: await api.running(sandboxId) };
  }

  bb.implement(modal.createImage, async (_input, { signal }) => {
    const { imageId, logs } = await buildImage(signal);
    return { imageId, logs };
  });
  bb.implement(modal.createSandbox, async (_input, { signal }) => {
    const { api, resolved, imageId, logs } = await buildImage(signal);
    const accountIdentity = await api.accountIdentity();
    signal.throwIfAborted();
    const key = `bb-debug-${randomUUID()}`;
    const expiresAt = bb.now() + DEBUG_LIFETIME_MS;
    const sandboxId = await api.create({
      appName: resolved.appName,
      name: key,
      imageId,
      timeoutMs: DEBUG_LIFETIME_MS,
      ...DEFAULT_SIZE,
      tags: { bbDebug: "true", bbMachineKey: key },
    });
    try {
      signal.throwIfAborted();
      const record = { accountIdentity, appName: resolved.appName, key };
      await kv.set(`debug/${sandboxId}`, record);
      return { imageId, logs, sandboxId, expiresAt };
    } catch (error) {
      await api.terminate(sandboxId);
      throw error;
    }
  });
  bb.implement(modal.createSandboxCommand, async ({ sandboxId, command }) => {
    const { api, running } = await debugSandbox(sandboxId);
    if (!running) {
      throw new Error(
        "Debug sandbox has stopped or expired; run a new sandbox",
      );
    }
    return api.exec(sandboxId, command, {
      timeoutMs: 60_000,
      maxOutputBytes: 131_072,
    });
  });
  bb.implement(modal.deleteSandbox, async ({ sandboxId }) => {
    const { api, running } = await debugSandbox(sandboxId);
    if (running) await api.terminate(sandboxId);
    return { sandboxId };
  });

  const loaded = resolveSettings(await settings.get());
  if (!loaded.ok) bb.status.needsConfiguration(loaded.message);
}
