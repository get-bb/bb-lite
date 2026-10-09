import { expect, it } from "vitest";
import { createTestServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof createTestServer>>;

async function call(server: Server, name: string, input: unknown) {
  const response = await server.send(`/ops/${name}`, input);
  const body = (await response.json()) as { code?: string };
  return { status: response.status, code: body.code };
}

it("answers bad input and unknown ids with 4xx instead of 500", async () => {
  const server = await createTestServer({}, "fake", ":memory:", "all");
  await expect(
    call(server, "settings.updateGeneral", {
      settings: { machineServerUrl: "not a url" },
    }),
  ).resolves.toMatchObject({ status: 400 });
  await expect(
    call(server, "thread-list.setPreference", {
      key: "showProviderIcons",
      value: "yes",
    }),
  ).resolves.toMatchObject({ status: 400 });
  await expect(
    call(server, "tasks.createLabel", {
      projectId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      name: "bug",
      color: "red",
    }),
  ).resolves.toMatchObject({ status: 404 });
  await expect(
    call(server, "threads.reorderQueuedMessages", {
      threadId: "thr_nonexist00",
      queuedMessageIds: [],
    }),
  ).resolves.toMatchObject({ status: 404, code: "thread_not_found" });
  await expect(
    call(server, "skills.list", { hostId: "host_nonexist00" }),
  ).resolves.toMatchObject({ status: 404, code: "host_not_found" });
});
