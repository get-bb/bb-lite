import * as client from "@bb/tunnel-client";
import * as wire from "@bb/tunnel-contract";
import { WebSocket } from "ws";
import { shareUrl, type Link } from "./account.js";
import type { ConnectStatus } from "./contract.js";

const CLEAN_CLOSE_CODE = 1000;
const STABLE_MS = 10_000;

export interface TunnelOptions {
  loopbackUrl: string;
  isShared(port: number): boolean;
  confirmRefused(credential: string): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  onChange(): void;
  handshakeMs?: number;
  replacedHoldMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  heartbeat?: { intervalMs: number; deadlineMs: number };
}

type TunnelStatus = Pick<ConnectStatus, "state" | "lastError" | "nextRetryAt">;

export class ConnectTunnel {
  private link: Link | null = null;
  private socket: WebSocket | undefined;
  private session: client.TunnelSession | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dialId = 0;
  private connected = false;
  private lastError: string | null = null;
  private nextRetryAt: number | null = null;
  private attempt = 0;

  constructor(private readonly options: TunnelOptions) {}

  set(link: Link | null): void {
    const same =
      link?.serverUrl === this.link?.serverUrl &&
      link?.credential === this.link?.credential;
    if (same) return;
    this.dialId += 1;
    clearTimeout(this.timer);
    this.session?.dispose();
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(CLEAN_CLOSE_CODE, "tunnel closed by bb");
    } else {
      socket?.terminate();
    }
    this.socket = undefined;
    this.connected = false;
    this.lastError = null;
    this.nextRetryAt = null;
    this.attempt = 0;
    this.link = link;
    this.dial();
  }

  status(): TunnelStatus {
    const { connected, lastError, nextRetryAt } = this;
    const live = connected ? "connected" : "reconnecting";
    const state = this.link === null ? "disconnected" : live;
    return { state, lastError, nextRetryAt };
  }

  private resolveOrigin(
    link: Link,
    target?: string,
  ): client.StreamOriginResult {
    if (target === undefined) {
      const origin = this.options.loopbackUrl;
      const publicOrigin = new URL(link.serverUrl).origin;
      return { kind: "ok", resolved: { origin, publicOrigin } };
    }
    const port = /^\d{1,5}$/u.test(target) ? Number(target) : Number.NaN;
    if (!this.options.isShared(port)) return { kind: "unregistered" };
    const host = `127.0.0.1:${port}`;
    const publicOrigin = shareUrl(link, port);
    const resolved = { origin: `http://${host}`, publicOrigin, host };
    return { kind: "ok", resolved };
  }

  private dial(): void {
    const { link } = this;
    const { log, handshakeMs = 10_000, heartbeat } = this.options;
    const { replacedHoldMs = 5 * 60_000 } = this.options;
    const { retryBaseMs = 1_000, retryMaxMs = 30_000 } = this.options;
    if (link === null) return;
    const dialId = ++this.dialId;
    const url = new URL(`${link.serverUrl.replace(/^http/u, "ws")}/__tunnel`);
    url.searchParams.set(
      wire.TUNNEL_PROTOCOL_QUERY_PARAM,
      String(wire.PROTOCOL_VERSION),
    );
    const headers = { authorization: `Bearer ${link.credential}` };
    const socket = new WebSocket(url, { headers });
    this.socket = socket;
    let openedAt = 0;
    let transportError: string | null = null;

    const fail = (reason: string, holdMs?: number): void => {
      if (dialId !== this.dialId) return;
      this.dialId += 1;
      clearTimeout(this.timer);
      this.session?.dispose();
      socket.terminate();
      const stable = openedAt !== 0 && Date.now() - openedAt > STABLE_MS;
      this.attempt = stable ? 0 : this.attempt + 1;
      const ceiling = Math.min(retryBaseMs * 2 ** this.attempt, retryMaxMs);
      const backoffMs = Math.round(ceiling * (0.5 + Math.random() / 2));
      const delay = holdMs ?? backoffMs;
      this.connected = false;
      this.lastError = reason;
      this.nextRetryAt = Date.now() + delay;
      log.warn(`${reason}; reconnecting in ${delay}ms`);
      this.timer = setTimeout(() => {
        this.nextRetryAt = null;
        this.dial();
      }, delay);
      this.options.onChange();
    };
    this.timer = setTimeout(() => {
      fail(`can't reach ${url.host}: the handshake timed out`);
    }, handshakeMs);

    socket.on("open", () => {
      if (dialId !== this.dialId) return;
      clearTimeout(this.timer);
      openedAt = Date.now();
      this.connected = true;
      this.lastError = null;
      log.info(`tunnel connected to ${url.host}`);
      const resolveOrigin = (target?: string): client.StreamOriginResult =>
        this.resolveOrigin(link, target);
      const session = { tunnel: socket, log, resolveOrigin, heartbeat };
      this.session = new client.TunnelSession(session);
      this.session.start();
      this.options.onChange();
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      const refused = status === 401 || status === 403;
      if (refused && dialId === this.dialId) {
        this.options.confirmRefused(link.credential).catch((error: unknown) => {
          log.warn(`could not check the refused credential: ${String(error)}`);
        });
      }
      fail(`the bb connect gate refused the tunnel (HTTP ${status})`);
    });
    socket.on("error", (error) => {
      transportError = `can't reach ${url.host}: ${error.message}`;
    });
    socket.on("close", (code, reason) => {
      const replaced =
        code === CLEAN_CLOSE_CODE &&
        reason.toString() === wire.TUNNEL_REPLACED_CLOSE_REASON;
      if (replaced) {
        const taken = "another bb took over this server's bb connect tunnel";
        return fail(taken, replacedHoldMs);
      }
      fail(transportError ?? `tunnel closed (code ${code})`);
    });
  }
}
