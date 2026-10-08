import {
  cliCommand,
  defineCli,
  sessions,
  type PluginServerApi,
} from "@bb/plugin";

export default function plugin(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    instructions: {
      type: "string",
      label: "Custom instructions",
      description:
        "Give agents extra instructions and context for tasks on this bb host.",
      multiline: true,
      default: "",
    },
  });

  bb.on(sessions.instructions, async (_context, next) => {
    const { instructions: text } = await settings.get();
    const rest = await next();
    if (text.trim() === "") return rest;
    return [{ source: bb.pluginId, text }, ...rest];
  });

  const replace = async (instructions: string, done: string) => {
    await settings.set({ instructions });
    return { exitCode: 0, stdout: done };
  };
  const commands = {
    get: cliCommand({
      summary: "Print the current custom instructions",
      async run() {
        const { instructions } = await settings.get();
        return { exitCode: 0, stdout: instructions };
      },
    }),
    set: cliCommand({
      summary: "Replace the custom instructions",
      positionals: [
        {
          name: "text",
          description: "Replacement instructions, joined with single spaces",
          required: true,
          variadic: true,
        },
      ],
      run: ({ positionals }) =>
        replace(positionals.text.join(" "), "Custom instructions updated"),
    }),
    clear: cliCommand({
      summary: "Clear the custom instructions",
      run: () => replace("", "Custom instructions cleared"),
    }),
  };
  const summary =
    "Read and update the custom instructions injected into agents";
  bb.cli.register(defineCli({ name: "instructions", summary, commands }));
}
