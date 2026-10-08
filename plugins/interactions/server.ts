import { threadEventItemPresentationSchema } from "@bb/domain";
import { interactions, threads, type PluginServerApi } from "@bb/plugin";

export default function interactionsPlugin(bb: PluginServerApi): void {
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
    return bb.call(threads.requestInput, { ...form, ...origin });
  });
}
