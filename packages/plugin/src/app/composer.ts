import type { ComponentType } from "react";
import { contract, slot } from "../contract.js";

export interface ComposerHandle {
  readonly key: string;
  readonly surface: "new-thread" | "follow-up";
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly text: string;
  readonly isEmpty: boolean;
  setText(text: string): void;
  updateText(update: (current: string) => string): void;
  insert(text: string): void;
  clear(): void;
  focus(): void;
  submit(): void;
}

export interface ComposerContext {
  surface: "new-thread" | "follow-up";
  threadId: string | null;
  projectId: string | null;
  host: unknown;
  composer?: ComposerHandle;
}

export interface ComposerBanner {
  id: string;
  order?: number;
  isAvailable?(composer: ComposerHandle): boolean;
  view: ComponentType<{ composer: ComposerHandle }>;
}

export interface ComposerMenuItem {
  id: string;
  label: string;
  icon: string;
  group?: string;
  order?: number;
  isAvailable?(context: ComposerContext): boolean;
  run(context: ComposerContext): void;
}

export interface ComposerFooterControlProps {
  context: ComposerContext;
}

export interface ComposerFooterControl {
  id: string;
  side: "start" | "end";
  row?: "actions" | "status";
  order?: number;
  isAvailable?(context: ComposerContext): boolean;
  view: ComponentType<ComposerFooterControlProps>;
}

export interface ComposerSendMenuItem {
  id: string;
  label: string;
  icon: string;
  iconClassName?: string;
  order?: number;
  isAvailable?(context: ComposerContext): boolean;
  run(context: ComposerContext): void;
}

export type EnvironmentInputsChange =
  | { status: "ready"; value: unknown }
  | { status: "blocked"; reason: string };

export interface EnvironmentInputsProps {
  projectId: string | null;
  hostId: string | null;
  value: unknown;
  onChange(next: EnvironmentInputsChange): void;
}

export interface EnvironmentInputsForm {
  kind: string;
  view: ComponentType<EnvironmentInputsProps>;
}

export const composer = contract("composer", {
  menuItem: slot<ComposerMenuItem>({ key: "id" }),
  footerControl: slot<ComposerFooterControl>({ key: "id" }),
  sendMenuItem: slot<ComposerSendMenuItem>({ key: "id" }),
  environmentInputs: slot<EnvironmentInputsForm>({ key: "kind" }),
  banner: slot<ComposerBanner>(),
});
