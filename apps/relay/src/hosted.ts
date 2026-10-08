import * as fly from "./fly.js";
import * as pages from "./pages.js";
import * as site from "./site.js";
import * as store from "./store.js";

type Site = site.Site;
type Server = store.Server;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WAKE_RETRY_MS = 15_000;
const VISIT_GAP_MS = 5 * 60_000;
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];
const NOT_CONFIGURED = "This relay cannot host servers yet.";
const IMAGE_SETTING = "hosted_image";

export function idleMs(env: site.Env) {
  return (Number(env.HOSTED_IDLE_HOURS) || 24) * HOUR_MS;
}

export function deleteMs(env: site.Env) {
  return (Number(env.HOSTED_DELETE_DAYS) || 30) * DAY_MS;
}

export function perAccount(env: site.Env) {
  return Number(env.HOSTED_PER_ACCOUNT) || 1;
}

export function isAvailable(env: site.Env) {
  return fly.flyOf(env) !== null;
}

export async function currentImage(context: Site): Promise<string> {
  const published = await store.setting(context.db, IMAGE_SETTING);
  return published ?? context.env.FLY_IMAGE ?? "";
}

function machineOf(server: Server): fly.Machine | null {
  const { hosted_app: app, hosted_machine: machine } = server;
  return app === null || machine === null ? null : { app, machine };
}

function reasonOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function create(
  context: Site,
  owner: store.User,
  label: string,
): Promise<string | null> {
  const config = fly.flyOf(context.env);
  if (config === null) return NOT_CONFIGURED;
  const made = await store.createHosted(context.db, owner, label);
  if (made === null) return "That address is taken.";
  const link = {
    baseUrl: context.apexOrigin,
    serverUrl: context.origin(label),
    serverId: made.id,
    serverLabel: label,
    credential: made.credential,
  };
  const env = {
    BB_CONNECT_BASE_URL: context.apexOrigin,
    BB_CONNECT_LINK: JSON.stringify(link),
  };
  try {
    const image = await currentImage(context);
    const machine = await fly.createMachine(config, made.app, image, env);
    await store.hostedMachineReady(context.db, made.id, machine, image);
    return null;
  } catch (error) {
    const reason = reasonOf(error);
    console.error(`hosted: creating ${made.app} failed: ${reason}`);
    await store.failHosted(context.db, made.id, reason);
    return "The server could not be created. Delete it and try again.";
  }
}

export async function wake(context: Site, server: Server): Promise<void> {
  const config = fly.flyOf(context.env);
  const machine = machineOf(server);
  if (config === null || machine === null) return;
  const claimed = await store.claimWake(context.db, server.id, WAKE_RETRY_MS);
  if (!claimed) return;
  try {
    const image = await currentImage(context);
    if (server.hosted_image !== image) {
      await fly.replaceImage(config, machine, image);
      await store.setHostedImage(context.db, server.id, image);
    }
    await fly.startMachine(config, machine);
  } catch (error) {
    console.error(`hosted: starting ${machine.app}: ${reasonOf(error)}`);
    await store.releaseWake(context.db, server.id);
  }
}

export async function update(context: Site, server: Server): Promise<boolean> {
  if (server.hosted_state === "stopped") {
    await wake(context, server);
    return true;
  }
  const config = fly.flyOf(context.env);
  const machine = machineOf(server);
  if (config === null || machine === null) return false;
  try {
    const image = await currentImage(context);
    await fly.replaceImage(config, machine, image);
    await store.setHostedImage(context.db, server.id, image);
    return true;
  } catch (error) {
    console.error(`hosted: updating ${machine.app}: ${reasonOf(error)}`);
    return false;
  }
}

export async function stop(
  context: Site,
  server: Server,
  idleBefore: number | null = null,
): Promise<boolean> {
  const config = fly.flyOf(context.env);
  const machine = machineOf(server);
  if (config === null || machine === null) return false;
  const claimed = await store.claimStop(context.db, server.id, idleBefore);
  if (!claimed) return false;
  try {
    await fly.stopMachine(config, machine);
    return true;
  } catch (error) {
    console.error(`hosted: stopping ${machine.app}: ${reasonOf(error)}`);
    await store.unclaimStop(context.db, server.id);
    return false;
  }
}

export async function remove(context: Site, server: Server): Promise<boolean> {
  const config = fly.flyOf(context.env);
  if (config === null || server.hosted_app === null) return false;
  try {
    await fly.destroyApp(config, server.hosted_app);
  } catch (error) {
    const reason = reasonOf(error);
    console.error(`hosted: deleting ${server.hosted_app}: ${reason}`);
    return false;
  }
  await store.deleteServer(context.db, server.id);
  await site.closeTunnel(context, server.id);
  return true;
}

function asleep(page: boolean, title: string, message: string) {
  if (page) return pages.notice(title, message, 503);
  return site.json({ code: "server_asleep", message }, 503);
}

export function hold(
  request: Request,
  context: Site,
  server: Server,
  owner: boolean,
  page: boolean,
  ctx: ExecutionContext,
): Response | null {
  const state = server.hosted_state;
  if (state === "running") {
    const reading = READ_METHODS.includes(request.method);
    const visiting = owner && (page || !reading);
    const stale = Date.now() - (server.active_at ?? 0) > VISIT_GAP_MS;
    if (visiting && stale) {
      ctx.waitUntil(store.noteActive(context.db, server.id));
    }
    return null;
  }
  if (state === "creating") return starting(page);
  if (state === "failed") {
    const message = "Its owner can delete it and create it again.";
    return asleep(page, "This bb server did not start", message);
  }
  if (!owner) {
    const message = "It starts again when its owner opens it.";
    return asleep(page, "This bb server is asleep", message);
  }
  if (!page) return asleep(false, "", "This bb server is asleep.");
  ctx.waitUntil(wake(context, server));
  return starting(true);
}

export function offline(
  context: Site,
  server: Server,
  owner: boolean,
  page: boolean,
  ctx: ExecutionContext,
): Response | null {
  if (server.hosted_state !== "running" || !page) return null;
  if (owner) ctx.waitUntil(wake(context, server));
  return starting(true);
}

function starting(page: boolean) {
  if (page) return pages.startingPage();
  return site.json(
    { code: "server_starting", message: "This bb server is starting." },
    503,
  );
}

export async function sweep(env: site.Env): Promise<void> {
  const context = site.siteOf(null, env);
  if (!isAvailable(env)) return;
  const now = Date.now();
  const idleBefore = now - idleMs(env);
  for (const server of await store.idleHosted(context.db, idleBefore)) {
    await stop(context, server, idleBefore);
  }
  const expiredBefore = now - deleteMs(env);
  for (const server of await store.expiredHosted(context.db, expiredBefore)) {
    await remove(context, server);
  }
}
