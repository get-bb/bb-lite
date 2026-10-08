import { threadEventItemPresentationSchema } from "@bb/domain";
import { interactions, type PluginServerApi } from "@bb/plugin";
import { coreOf } from "@bb/server-kit/host";

export default function interactionsPlugin(bb: PluginServerApi): void {
  const { ctx } = coreOf(bb);
  bb.implement(interactions.ask, (request, { caller }) => {
    const { threadId, rendererId, title, payload, timeoutMs } = request;
    const timeout =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const limits = [request.signal, timeout];
    const signal = AbortSignal.any(
      limits.filter((limit) => limit !== undefined),
    );
    const presentation = threadEventItemPresentationSchema.safeParse(
      request.presentation,
    ).data;
    const { describeSubmission } = request;
    const form = { threadId, rendererId, title, payload, presentation };
    const pluginId = caller.via.at(-1) ?? "core";
    const origin = { pluginId, signal, describeSubmission };
    return ctx.threads.requestInput({ ...form, ...origin });
  });
}
