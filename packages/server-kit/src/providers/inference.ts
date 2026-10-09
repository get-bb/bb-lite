import {
  sessions,
  type CompletionRequest,
  type PluginServerApi,
  type Transcriber,
} from "@bb/plugin";

export async function pickTranscriber(
  bb: PluginServerApi,
): Promise<Transcriber | null> {
  for (const transcriber of bb.read(sessions.transcription)) {
    const ready = await Promise.resolve(transcriber.available()).catch(
      () => false,
    );
    if (ready) return transcriber;
  }
  return null;
}

export async function transcriberAvailable(
  bb: PluginServerApi,
): Promise<boolean> {
  return (await pickTranscriber(bb)) !== null;
}

export function canInfer(bb: PluginServerApi): boolean {
  const services = bb.entries(sessions.inference);
  return services.length > 0 || bb.pick(sessions.completion) !== null;
}

export async function infer(
  bb: PluginServerApi,
  request: CompletionRequest,
  signal: AbortSignal,
): Promise<string | null> {
  const prompt = [request.system, request.prompt]
    .filter((part) => part !== undefined)
    .join("\n\n");
  const attempts = [
    ...bb.entries(sessions.inference).map(({ plugin, item }) => ({
      plugin,
      run: () => item.complete(prompt, { signal }),
    })),
    ...[bb.pick(sessions.completion)].flatMap((service) =>
      service === null
        ? []
        : [
            {
              plugin: "completion",
              run: async () =>
                (await service.complete(request, { signal })).text,
            },
          ],
    ),
  ];
  for (const { plugin, run } of attempts) {
    const text = await run().catch((err: unknown) => {
      bb.log.warn("A plugin's inference service failed", { plugin, err });
      return null;
    });
    if (text !== null && text.trim() !== "") return text.trim();
  }
  return null;
}
