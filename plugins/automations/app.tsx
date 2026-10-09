import { composer, type PluginAppApi, shell } from "@bb/plugin/app";
import { AutomationsPanel } from "./app/panel.js";
import { withCreateAutomationPrompt } from "./app/schedule.js";

export default function automationsApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "automations",
    title: "Automations",
    icon: "Repeat",
    path: "automations",
    view: AutomationsPanel,
  });
  bb.add(composer.menuItem, {
    id: "automation",
    label: "Automation",
    icon: "Repeat",
    run: ({ composer: handle }) => {
      if (handle === null) return;
      const text = withCreateAutomationPrompt(handle.text);
      const shift = text.length - handle.text.length;
      handle.setDraft({
        text,
        mentions: handle.mentions.map((mention) => ({
          ...mention,
          start: mention.start + shift,
          end: mention.end + shift,
        })),
      });
      handle.focus();
    },
  });
}
