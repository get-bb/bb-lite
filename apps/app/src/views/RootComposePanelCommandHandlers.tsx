import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";

interface RootComposePanelCommandHandlersProps {
  isFocused: boolean;
  onClose: () => boolean;
  onToggle: () => void;
}

export function RootComposePanelCommandHandlers({
  isFocused,
  onClose,
  onToggle,
}: RootComposePanelCommandHandlersProps) {
  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused) return false;
    onToggle();
    return true;
  });
  useAppCommandHandler("panel.close", () => {
    if (!isFocused) return false;
    return onClose();
  });
  return null;
}
