import {
  BUNDLED_NAVIGATION_PROVIDER,
  sidebarNavigationProviderAtom,
} from "@/components/sidebar/sidebarNavigationProvider";
import { usePluginSlots } from "@/plugins/registry";
import { ReplacementProviderSetting } from "./ReplacementProviderSetting";

export function SidebarNavigationSetting() {
  const { sidebarNavigations } = usePluginSlots();
  return (
    <ReplacementProviderSetting
      label="Navigation"
      triggerAriaLabel="Sidebar navigation"
      description="Choose who arranges the host-owned sidebar destinations on this device."
      bundledProvider={BUNDLED_NAVIGATION_PROVIDER}
      preferenceAtom={sidebarNavigationProviderAtom}
      slots={sidebarNavigations}
    />
  );
}
