import type {
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
} from "@bb/domain";
import type { ComponentType } from "react";
import { contract, service, slot } from "../contract.js";

export interface ComposerSelection {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
}

export interface ComposerTextEffect {
  id: string;
  className: string;
  match(
    text: string,
    run: { offset: number },
  ): readonly { from: number; to: number }[];
}

export interface ComposerMention {
  start: number;
  end: number;
  resource: unknown;
}

export interface ComposerSubmitOptions {
  sendAt?: number;
}

export interface ComposerHandle {
  readonly key: string;
  readonly surface: "new-thread" | "follow-up";
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly text: string;
  readonly mentions: readonly ComposerMention[];
  readonly isEmpty: boolean;
  readonly isRunning: boolean;
  readonly isSubmittingBlocked: boolean;
  readonly submittingBlockedReason: string | null;
  readonly attachmentCount: number;
  readonly layout: "expanded" | "compact";
  readonly selection: ComposerSelection | null;
  setSelection(selection: ComposerSelection): void;
  setTextEffect(effect: { className: string } | null): void;
  setText(text: string): void;
  setDraft(draft: {
    text: string;
    mentions?: readonly ComposerMention[];
  }): void;
  input(): PromptInput[];
  updateText(update: (current: string) => string): void;
  insert(text: string): void;
  insertMention(resource: unknown, text: string): void;
  addQuote(text: string): void;
  clear(): void;
  focus(): void;
  setInputLock(locked: boolean): void;
  submit(options?: ComposerSubmitOptions): void;
  onSubmitted(listener: () => void): () => void;
}

export interface ComposerContext {
  surface: "new-thread" | "follow-up";
  threadId: string | null;
  projectId: string | null;
  composer: ComposerHandle | null;
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

export interface HomeSection {
  id: string;
  order?: number;
  view: ComponentType;
}

export interface ComposerApi {
  useComposer(): ComposerHandle | null;
  useComposers(): readonly ComposerHandle[];
  active(): ComposerHandle | null;
}

export const composer = contract("composer", {
  api: service<ComposerApi>(),
  menuItem: slot<ComposerMenuItem>({ key: "id" }),
  footerControl: slot<ComposerFooterControl>({ key: "id" }),
  sendMenuItem: slot<ComposerSendMenuItem>({ key: "id" }),
  environmentInputs: slot<EnvironmentInputsForm>({ key: "kind" }),
  banner: slot<ComposerBanner>(),
  textEffect: slot<ComposerTextEffect>({ key: "id" }),
  homeSection: slot<HomeSection>(),
});
