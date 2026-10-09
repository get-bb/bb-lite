import {
  PluginCliError,
  cliCommand,
  defineCli,
  sessions,
  type PluginServerApi,
} from "@bb/plugin";

const MAX_LENGTH = 4096;
const json = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

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

  const output = (instructions: string, asJson: boolean, done: string) => ({
    exitCode: 0,
    stdout: asJson ? JSON.stringify({ instructions }) : done,
  });
  const replace = async (text: string, asJson: boolean, done: string) => {
    if (text.length > MAX_LENGTH) {
      throw new PluginCliError(
        `Custom instructions must be at most ${MAX_LENGTH} characters`,
        { code: "invalid_instructions" },
      );
    }
    await settings.set({ instructions: text });
    return output(text, asJson, done);
  };
  const commands = {
    get: cliCommand({
      summary: "Print the current custom instructions",
      options: { json },
      async run({ options }) {
        const { instructions } = await settings.get();
        return output(instructions, options.json === true, instructions);
      },
    }),
    set: cliCommand({
      summary: "Replace the custom instructions",
      positionals: [
        {
          name: "text",
          description: `Replacement instructions, joined with single spaces; at most ${MAX_LENGTH} characters`,
          required: true,
          variadic: true,
        },
      ],
      options: { json },
      run: ({ positionals, options }) =>
        replace(
          positionals.text.join(" "),
          options.json === true,
          "Custom instructions updated",
        ),
    }),
    clear: cliCommand({
      summary: "Clear the custom instructions",
      options: { json },
      run: ({ options }) =>
        replace("", options.json === true, "Custom instructions cleared"),
    }),
  };
  const summary =
    "Read and update the custom instructions injected into agents";
  bb.cli.register(defineCli({ name: "instructions", summary, commands }));
}
