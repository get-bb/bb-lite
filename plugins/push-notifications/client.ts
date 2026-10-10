import { z } from "zod";
import type { ClientChannel, ClientNotification } from "./contract.js";

const desktopSchema = z.object({
  platform: z.string().optional(),
  focusWindow: z.custom<() => void>((v) => typeof v === "function").optional(),
});

function desktop() {
  const parsed = desktopSchema.safeParse(Reflect.get(window, "bbDesktop"));
  return parsed.success ? parsed.data : null;
}

export function clientChannel(): ClientChannel | null {
  if ("bbDesktop" in window) return "desktop";
  const host: unknown = Reflect.get(window, "bb");
  if (typeof host === "object" && host !== null && "native" in host) {
    return null;
  }
  return "web";
}

export function permission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

const seenIds = z.array(z.string()).catch([]);

export function createClientDelivery(navigate: (threadId: string) => void) {
  const active = new Set<Notification>();
  let disposed = false;

  function display(message: ClientNotification): void {
    if (disposed || permission() !== "granted") return;
    const host = desktop();
    const notification = new Notification(message.title, {
      body: message.body,
      ...(host?.platform === "macos"
        ? {}
        : { icon: new URL("/icon-192.png", window.location.origin).href }),
      tag: `bb-${message.threadId ?? message.id}`,
    });
    active.add(notification);
    notification.onclose = () => active.delete(notification);
    notification.onclick = () => {
      if (disposed) return;
      window.focus();
      if (host?.platform === "linux") host.focusWindow?.();
      if (message.threadId !== null) navigate(message.threadId);
      notification.close();
      active.delete(notification);
    };
  }

  async function deliver(
    message: ClientNotification,
    enabled: boolean,
  ): Promise<void> {
    const channel = clientChannel();
    if (
      !enabled ||
      disposed ||
      channel === null ||
      !message.channels.includes(channel) ||
      permission() !== "granted"
    ) {
      return;
    }
    const key = `bb.push-notifications.seen.${channel}`;
    const claim = () => {
      if (disposed) return;
      let ids: string[] = [];
      try {
        ids = seenIds.parse(JSON.parse(localStorage.getItem(key) ?? "[]"));
      } catch {
        ids = [];
      }
      if (ids.includes(message.id)) return;
      display(message);
      try {
        localStorage.setItem(
          key,
          JSON.stringify([...ids.slice(-99), message.id]),
        );
      } catch {
        return;
      }
    };
    if (navigator.locks) {
      await navigator.locks.request(`bb-notifications-${channel}`, claim);
    } else {
      claim();
    }
  }

  return {
    deliver,
    dispose() {
      disposed = true;
      for (const notification of active) notification.close();
      active.clear();
    },
  };
}
