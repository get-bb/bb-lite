import { Toaster } from "sonner";
import { usePreferredTheme } from "@/hooks/useTheme";

export function AppToaster() {
  const theme = usePreferredTheme();
  return <Toaster theme={theme} position="bottom-right" />;
}
