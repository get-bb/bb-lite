import {
  composer,
  definePluginApp,
  type ComposerContext,
  type ComposerFooterControlProps,
} from "@bb/plugin/app";
import { ModelReasoningPicker } from "./app/components/pickers/ModelReasoningPicker";
import { PermissionModePicker } from "./app/components/pickers/PermissionModePicker";
import { ProjectSelector } from "./app/components/pickers/ProjectSelector";
import {
  composerFooterHost,
  composerMenuHost,
  composerSendHost,
} from "./app/components/promptbox/composer-slots";
import { ThreadContextWindowIndicator } from "bb-plugin-thread-view/contract";
import { appParts } from "@bb/app-kit/plugins/parts";
import * as parts from "./parts";

function skillsAction(context: ComposerContext) {
  const action = composerMenuHost(context).actions.find(
    (candidate) => candidate.kind === "skills",
  );
  return action && action.text.length > 0 ? action : undefined;
}

function ModelControl({ context }: ComposerFooterControlProps) {
  return <ModelReasoningPicker {...composerFooterHost(context).model} />;
}

function ProjectControl({ context }: ComposerFooterControlProps) {
  const { project } = composerFooterHost(context);
  return project === null ? null : <ProjectSelector {...project} />;
}

function EnvironmentControl({ context }: ComposerFooterControlProps) {
  return composerFooterHost(context).environment;
}

function PermissionControl({ context }: ComposerFooterControlProps) {
  return <PermissionModePicker {...composerFooterHost(context).permission} />;
}

function ContextWindowControl({ context }: ComposerFooterControlProps) {
  const usage = composerFooterHost(context).contextWindowUsage;
  return usage ? <ThreadContextWindowIndicator usage={usage} /> : null;
}

export default definePluginApp((bb) => {
  bb.add(appParts.parts, { plugin: "composer", parts });
  bb.add(composer.menuItem, {
    id: "attach",
    label: "Attach files",
    icon: "Paperclip",
    group: "attach",
    order: 0,
    isAvailable: (context) => composerMenuHost(context).attach !== undefined,
    run: (context) => composerMenuHost(context).attach?.(),
  });
  bb.add(composer.menuItem, {
    id: "skills",
    label: "Skills",
    icon: "Zap",
    order: 10,
    isAvailable: (context) => skillsAction(context) !== undefined,
    run: (context) => {
      const action = skillsAction(context);
      if (action) composerMenuHost(context).applyAction(action);
    },
  });

  bb.add(composer.footerControl, {
    id: "model",
    row: "actions",
    side: "start",
    order: 0,
    view: ModelControl,
  });
  bb.add(composer.footerControl, {
    id: "project",
    side: "start",
    order: 0,
    isAvailable: (context) => composerFooterHost(context).project !== null,
    view: ProjectControl,
  });
  bb.add(composer.footerControl, {
    id: "environment",
    side: "start",
    order: 10,
    view: EnvironmentControl,
  });
  bb.add(composer.footerControl, {
    id: "permission",
    side: "end",
    order: 0,
    view: PermissionControl,
  });
  bb.add(composer.footerControl, {
    id: "context-window",
    side: "end",
    order: 10,
    isAvailable: (context) =>
      Boolean(composerFooterHost(context).contextWindowUsage),
    view: ContextWindowControl,
  });

  bb.add(composer.sendMenuItem, {
    id: "steer",
    label: "Steer",
    icon: "CornerDownRight",
    order: 0,
    isAvailable: (context) => {
      const host = composerSendHost(context);
      return host.submit !== undefined && !host.queue;
    },
    run: (context) => composerSendHost(context).submit?.(),
  });
  bb.add(composer.sendMenuItem, {
    id: "queue",
    label: "Queue",
    icon: "ListEnd",
    iconClassName: "-scale-x-100",
    order: 0,
    isAvailable: (context) => {
      const host = composerSendHost(context);
      return host.submit !== undefined && host.queue;
    },
    run: (context) => composerSendHost(context).submit?.(),
  });
});
