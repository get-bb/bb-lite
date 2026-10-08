import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Label } from "@bb/shared-ui/label";
import { useState } from "react";
import type { Dashboard } from "../../src/dashboard-types.js";
import { post } from "../data";
import { AddressField, Panel, Problem } from "./shell";
import { useAction } from "./use-action";

const LINK_COMMAND = "bb connect login";

function hours(count: number) {
  return count === 24 ? "a day" : `${count} hours`;
}

function CreateHosted({ dashboard }: { dashboard: Dashboard }) {
  const { hosting, baseHost } = dashboard;
  const [label, setLabel] = useState(hosting.suggestedLabel);
  const { pending, problem, run } = useAction();
  const creating = pending !== null;
  return (
    <Panel className="p-5">
      <div className="flex items-start gap-3">
        <Icon name="ComputerCloud" className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Create a hosted server</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A bb server in the cloud with agents ready to sign in. It sleeps
            after {hours(hosting.idleHours)} without a visit and wakes when you
            open it.
          </p>
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run("create", async () => {
                const body = { label };
                const { url } = await post<{ url: string }>("/servers", body);
                window.location.assign(url);
              });
            }}
          >
            <Label htmlFor="hosted-address" className="sr-only">
              Address
            </Label>
            <div className="flex flex-wrap gap-2">
              <AddressField
                id="hosted-address"
                value={label}
                baseHost={baseHost}
                disabled={creating}
                onChange={setLabel}
              />
              <Button type="submit" disabled={creating}>
                {creating ? (
                  <Icon name="Spinner" className="animate-spin" />
                ) : null}
                {creating ? "Creating…" : "Create server"}
              </Button>
            </div>
            <Problem message={problem} />
          </form>
        </div>
      </div>
    </Panel>
  );
}

function LinkOwn() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(LINK_COMMAND).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <Panel className="p-5">
      <div className="flex items-start gap-3">
        <Icon name="Laptop" className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Link a server you run</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Give a bb server on your own machine an address here. Run this on
            it, then approve the code it shows.
          </p>
          <div className="mt-4 flex h-9 items-center justify-between rounded-md border border-border-hairline bg-surface-recessed pl-3 pr-1">
            <code className="font-mono text-xs">{LINK_COMMAND}</code>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Copy the command"
              onClick={() => void copy()}
            >
              <Icon name={copied ? "Check" : "Copy"} />
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function AddServer({ dashboard }: { dashboard: Dashboard }) {
  if (!dashboard.viewer.canHost) {
    return (
      <Panel className="p-5">
        <p className="text-sm text-muted-foreground">
          Your account can open servers it is invited to. To create or link a
          server of your own, ask this relay's admin to allow hosting on your
          account.
        </p>
      </Panel>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3">
      {dashboard.hosting.canCreate ? (
        <CreateHosted dashboard={dashboard} />
      ) : null}
      <LinkOwn />
    </div>
  );
}
