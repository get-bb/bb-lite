import { useCallback } from "react";
import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import type { PluginComposerHost } from "./plugin-composer-host";

interface UseComposerExtensionControllerOptions {
  host: PluginComposerHost | null;
  isFocused: boolean;
  isPrimary: boolean;
  collapseIfFocused?(): boolean;
  focusDefault(): boolean;
}

export function useComposerExtensionController({
  host,
  isFocused,
  isPrimary,
  collapseIfFocused,
  focusDefault,
}: UseComposerExtensionControllerOptions): void {
  const focus = useCallback(() => {
    if (!isFocused || !isPrimary) return false;
    if (collapseIfFocused?.()) return true;
    if (host !== null) {
      host.focus();
      return true;
    }
    return focusDefault();
  }, [collapseIfFocused, focusDefault, host, isFocused, isPrimary]);
  useAppCommandContext("promptAvailable", true);
  useAppCommandHandler("composer.focus", focus);
}
