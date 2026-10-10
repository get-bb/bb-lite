import { machines, type MachineRef } from "@bb/plugin";
import { expect, it } from "vitest";
import { updateHost } from "@bb/server-kit/db/hosts";
import * as helpers from "./helpers.js";

it("lets a machine provider read, reconcile and bootstrap its machines", async () => {
  const server = await helpers.createTestServer({}, "echo");
  const { ctx } = server;
  const scope = ctx.kernel.scope("fake-cloud", "installed");
  const reconciled: MachineRef[] = [];
  scope.add(machines.provider, {
    id: "fake-cloud",
    displayName: "Fake cloud",
    reconcile: (machine) => void reconciled.push(machine),
  });
  const resource = { sandboxId: "sb-1" };
  const enrolled = await scope.call(machines.enroll, {
    name: "Cloud box",
    providerId: "fake-cloud",
    resource,
  });
  const { hostId, script } = enrolled;
  expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  expect(script).toContain("command -v bb");
  expect(script).toContain("/install.sh");
  expect(script).toContain(`exec ${enrolled.command}\n`);
  expect(await scope.call(machines.resource, { hostId })).toEqual(resource);
  await scope.call(machines.reconcile, { hostId });
  expect(reconciled).toEqual([{ hostId, resource }]);
  const local = ctx.config.hostId;
  const unknown = scope.call(machines.reconcile, { hostId: local });
  await expect(unknown).rejects.toThrow("cannot reconcile");
  updateHost(ctx.db, hostId, { threadStorageRoot: "/srv/threads" });
  const listed = await scope.call(machines.list, { includeCreating: true });
  expect(listed.find((host) => host.id === hostId)).toMatchObject({
    threadStorageRootPath: "/srv/threads",
  });
  const http = await server.request(`/machines/${hostId}/resource`);
  expect(http.status).toBe(404);
});
