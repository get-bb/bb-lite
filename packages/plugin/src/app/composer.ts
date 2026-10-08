import type { ComponentType } from "react";
import { contract, slot } from "../contract.js";

export interface ComposerContext {
  surface: "new-thread" | "follow-up";
  threadId: string | null;
  projectId: string | null;
  host: unknown;
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

export const composer = contract("composer", {
  menuItem: slot<ComposerMenuItem>({ key: "id" }),
  footerControl: slot<ComposerFooterControl>({ key: "id" }),
  sendMenuItem: slot<ComposerSendMenuItem>({ key: "id" }),
});
