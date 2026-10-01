import { PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES } from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { getThread } from "../../db/threads.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest } from "../errors.js";

const OK = { ok: true } as const;

export function registerThreadRoutes(app: ApiApp, ctx: ServerContext): void {
  const { del, patch, post } = typedApi(app);
  const routes = publicApiRoutes.threads;
  const { threads } = ctx;

  post(routes.create, async (c, payload) =>
    c.json(await threads.create(payload), 201),
  );

  patch(routes.update, async (c, payload) =>
    c.json(await threads.update(c.req.param("id"), payload)),
  );

  del(routes.delete, async (c, payload) => {
    await threads.delete(c.req.param("id"), payload);
    return c.json(OK);
  });

  post(routes.send, async (c, payload) =>
    c.json(await threads.send(c.req.param("id"), payload)),
  );

  post(routes.stop, async (c) => {
    await threads.stop(c.req.param("id"));
    return c.json(OK);
  });

  post(routes.compact, async (c) => {
    await threads.compact(c.req.param("id"));
    return c.json(OK);
  });

  post(routes.clearContext, async (c) => {
    await threads.clearContext(c.req.param("id"));
    return c.json(OK);
  });

  post(routes.archiveAll, async (c) => {
    const archivedThreadIds = await threads.archive(c.req.param("id"));
    return c.json({ ...OK, archivedThreadIds });
  });

  post(routes.unarchive, async (c) => {
    await threads.unarchive(c.req.param("id"));
    return c.json(OK);
  });

  post(routes.pin, async (c) => c.json(await threads.pin(c.req.param("id"))));

  post(routes.unpin, async (c) =>
    c.json(await threads.unpin(c.req.param("id"))),
  );

  patch(routes.pinOrder, async (c, payload) =>
    c.json(await threads.reorderPinned(c.req.param("id"), payload)),
  );

  post(routes.read, async (c) =>
    c.json(await threads.markRead(c.req.param("id"))),
  );

  post(routes.unread, async (c) =>
    c.json(await threads.markUnread(c.req.param("id"))),
  );

  post(routes.createQueuedMessage, async (c, payload) =>
    c.json(await threads.createQueuedMessage(c.req.param("id"), payload), 201),
  );

  patch(routes.setQueuedMessageGroupBoundary, async (c, payload) =>
    c.json(
      await threads.setQueuedMessageGroupBoundary(c.req.param("id"), payload),
    ),
  );

  patch(routes.updateQueuedMessage, async (c, payload) => {
    const { id, queuedMessageId } = c.req.param();
    return c.json(
      await threads.updateQueuedMessage(id, queuedMessageId, payload),
    );
  });

  del(routes.deleteQueuedMessage, async (c) => {
    const { id, queuedMessageId } = c.req.param();
    await threads.deleteQueuedMessage(id, queuedMessageId);
    return c.json(OK);
  });

  post(routes.sendQueuedMessage, async (c, payload) => {
    const { id, queuedMessageId } = c.req.param();
    const { mode } = payload;
    return c.json(
      await threads.sendQueuedMessageNow(id, queuedMessageId, mode),
    );
  });

  patch(routes.reorderQueuedMessage, async (c, payload) => {
    const { id, queuedMessageId } = c.req.param();
    return c.json(
      await threads.reorderQueuedMessage(id, queuedMessageId, payload),
    );
  });

  post(routes.resolveInteraction, async (c, payload) => {
    const { id, interactionId } = c.req.param();
    return c.json(await threads.resolveInteraction(id, interactionId, payload));
  });

  post(routes.respondToInteraction, async (c, payload) => {
    const { id, interactionId } = c.req.param();
    const size = Buffer.byteLength(JSON.stringify(payload.value), "utf8");
    if (size > PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES) {
      const message = "Interaction response exceeds 64 KiB";
      throw new ApiError(413, "invalid_request", message);
    }
    return c.json(
      await threads.respondToInteraction(id, interactionId, payload.value),
    );
  });

  post(routes.cancelInteraction, async (c) => {
    const { id, interactionId } = c.req.param();
    return c.json(await threads.cancelInteraction(id, interactionId));
  });

  post(routes.open, (c, payload) => {
    const thread = getThread(ctx.db, c.req.param("id"));
    if (thread === undefined || thread.deletedAt !== null) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    const { file } = payload;
    if (file !== null && file.path.split("/").includes("..")) {
      throw invalidRequest("File path must stay inside its root.");
    }
    const { projectId, id: threadId } = thread;
    const split = payload.split ?? "replace";
    const delivered = ctx.hub.threadOpen({ projectId, threadId, split, file });
    return c.json({ delivered });
  });
}
