import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { callOp, composer, type PluginAppApi } from "@bb/plugin/app";
import { drafts } from "./contract.js";

export default function draftsApp(bb: PluginAppApi): void {
  bb.add(composer.sendMenuItem, {
    id: "drafts",
    label: "Save draft…",
    icon: "EditFile",
    isAvailable: ({ surface, composer: handle }) =>
      surface === "follow-up" && handle?.isSubmittingBlocked !== true,
    run: async ({ threadId, composer: handle }) => {
      const empty =
        handle === null || (handle.isEmpty && handle.attachmentCount === 0);
      if (threadId === null || handle === null || empty) {
        appToast.error("Nothing to save", {
          description: "Type a message first, then save it as a draft.",
        });
        return;
      }
      try {
        await callOp(drafts.create, { threadId, input: handle.input() });
        handle.clear();
        appToast.success("Draft saved");
      } catch (error: unknown) {
        appToast.error(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
