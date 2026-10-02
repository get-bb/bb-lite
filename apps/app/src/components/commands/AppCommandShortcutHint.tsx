import { AppCommandShortcutPill } from "@bb/shared-ui/app-command-shortcut-pill";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { useIsAppCommandModifierHeld } from "./AppCommandProvider";

interface AppCommandShortcutHintProps {
  shortcut: AppShortcutPresentation | null;
  className?: string;
}

export function AppCommandShortcutHint({
  shortcut,
  className,
}: AppCommandShortcutHintProps) {
  const isPrimaryModifierHeld = useIsAppCommandModifierHeld();
  if (!isPrimaryModifierHeld || !shortcut) return null;

  return <AppCommandShortcutPill shortcut={shortcut} className={className} />;
}
