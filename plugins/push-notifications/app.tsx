import { useEffect, useRef, useState } from "react";
import {
  settings,
  shell,
  useBbNavigate,
  useCall,
  useLive,
  useSettings,
  type PluginAppApi,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { pushNotifications, type ClientNotification } from "./contract.js";
import { clientChannel, createClientDelivery, permission } from "./client.js";

function NotificationDelivery() {
  const navigate = useBbNavigate();
  const { values } = useSettings();
  const latest = useLive(pushNotifications.notification);
  const delivery = useRef<ReturnType<typeof createClientDelivery> | null>(null);
  const initial = useRef<ClientNotification | null | undefined>(undefined);
  useEffect(() => {
    const next = createClientDelivery((id) => navigate.toThread(id));
    delivery.current = next;
    return () => {
      delivery.current = null;
      next.dispose();
    };
  }, [navigate]);
  useEffect(() => {
    if (latest === undefined) return;
    if (initial.current === undefined) {
      initial.current = latest;
      return;
    }
    if (latest === null || latest.id === initial.current?.id) return;
    const channel = clientChannel();
    const enabled = channel !== null && values?.[`${channel}Enabled`] === true;
    void delivery.current?.deliver(latest, enabled).catch(() => undefined);
  }, [latest, values]);
  return null;
}

const STATUS = {
  unsupported:
    "System notifications are unavailable here. Use a supported browser over HTTPS or localhost.",
  denied:
    "Notifications are blocked. Allow them in your browser or system notification settings, then return here.",
  granted:
    "Notifications allowed. Your system notification settings also apply.",
  default: "Allow notifications on this device to receive thread updates.",
};

function NotificationSettings() {
  const sendTest = useCall(pushNotifications.test);
  const { values } = useSettings();
  const channel = clientChannel();
  const [current, setCurrent] = useState(permission);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setCurrent(permission());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  if (channel === null) return null;
  const enabled = values?.[`${channel}Enabled`] === true;
  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">
        {channel === "desktop" ? "This desktop app" : "This browser"}
      </h3>
      <p className="text-muted-foreground" role="status">
        {STATUS[current]}
      </p>
      {current === "default" ? (
        <Button
          variant="outline"
          disabled={busy || !enabled}
          onClick={() =>
            void run(async () => {
              setCurrent(await Notification.requestPermission());
              return null;
            })
          }
        >
          Allow notifications
        </Button>
      ) : null}
      {current === "granted" ? (
        <Button
          variant="outline"
          disabled={busy || !enabled}
          onClick={() =>
            void run(async () => {
              await sendTest({ channel });
              return `Test sent to connected ${channel} clients with notification permission.`;
            })
          }
        >
          Send test notification
        </Button>
      ) : null}
      {!enabled ? (
        <p className="text-muted-foreground">
          Enable {channel} notifications above to receive updates.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Channel settings apply to this bb server. Each browser needs permission.
        Click a notification to open its thread.
      </p>
    </div>
  );
}

export default function pushNotificationsApp(bb: PluginAppApi): void {
  bb.add(shell.overlay, { id: "delivery", view: NotificationDelivery });
  bb.add(settings.section, { id: "device", view: NotificationSettings });
}
