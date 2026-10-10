import { composer, type PluginAppApi } from "@bb/plugin/app";

const CREATE_PLUGIN_PROMPT = "Create a new bb plugin that ";

export const withCreatePluginPrompt = (text: string): string => {
  const rest = text.trimStart();
  const body = rest.startsWith(CREATE_PLUGIN_PROMPT)
    ? rest.slice(CREATE_PLUGIN_PROMPT.length)
    : rest;
  return `${CREATE_PLUGIN_PROMPT}${body}`;
};

export default function bbGuideApp(bb: PluginAppApi): void {
  bb.add(composer.menuItem, {
    id: "plugin",
    label: "Plugin",
    icon: "Plug02",
    run: ({ composer: handle }) => handle?.updateText(withCreatePluginPrompt),
  });
}
