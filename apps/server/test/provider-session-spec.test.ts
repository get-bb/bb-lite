import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import { expect, it } from "vitest";
import { createThreadServer, events } from "./thread-harness.js";

it("passes the provider's instruction mode and a checkpoint fork to the session", async () => {
  const server = await createThreadServer();
  const { ctx, ingest, runTurn, submitted } = server;
  const source = await server.spawn();
  await runTurn(source, "t1");
  expect(submitted[0]?.session.instructionMode).toBeUndefined();
  const checkpoint = {
    ...events.completed("t2"),
    providerCheckpointId: "leaf-7",
  };
  await ingest(source, events.started("t2"), checkpoint);
  const definition = findProviderDefinition(ctx.db, "codex");
  if (definition === undefined) throw new Error("codex is not declared");
  definition.instructionMode = "replace";
  definition.info.capabilities.fork = "checkpoint";

  const fork = await server.spawn();
  await runTurn(fork, "f1");
  ctx.db.run(
    `UPDATE threads SET origin_kind = 'fork', source_thread_id = ?,
       provider_thread_id = NULL WHERE id = ?`,
    source,
    fork,
  );
  await server.send(fork, "start", "Continue from the checkpoint");
  const { session } = submitted[submitted.length - 1] ?? {};
  expect(session).toMatchObject({
    threadId: fork,
    instructionMode: "replace",
    forkFrom: { providerThreadId: "prov-1", checkpointId: "leaf-7" },
  });
});
