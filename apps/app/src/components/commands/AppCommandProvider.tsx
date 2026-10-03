import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PANE_DIRECTION_APP_COMMAND_IDS,
  defaultAppSettings,
  isAppKeybindingAvailableForClient,
  keyboardPlatform,
  isMacKeyboardPlatform,
  matchesAppShortcut,
  type AppCommandContext,
  type AppCommandContextKey,
  type AppDefaultKeybinding,
  type AppKeybinding,
  type KeyboardCommandId,
} from "@bb/domain";
import { usePluginCommandBindings } from "@/hooks/usePluginCommandBindings";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  browserPlatform,
  isEditableKeyboardTarget,
  matchesAppCommandContext,
  presentAppShortcut,
  type AppShortcutPresentation,
} from "@/lib/app-keybindings";

interface AppCommandInvocation {
  target: EventTarget | null;
}

type AppCommandHandler = (invocation: AppCommandInvocation) => boolean;
type Dispatch = (
  command: KeyboardCommandId,
  target: EventTarget | null,
) => boolean;

export interface AppCommandRunner {
  dispatch: Dispatch;
  getShortcutCommand: (
    event: KeyboardEvent,
    commands: readonly KeyboardCommandId[],
  ) => KeyboardCommandId | null;
  isCommandAvailable: Dispatch;
}

interface AppCommandProviderValue extends AppCommandRunner {
  keybindings: readonly AppKeybinding[];
  handleKeyboardEvent: (event: KeyboardEvent) => boolean;
  registerContext: (
    key: AppCommandContextKey,
    source: symbol,
    active: boolean,
  ) => void;
  registerHandler: (
    command: KeyboardCommandId,
    handler: AppCommandHandler,
    priority: number,
  ) => () => void;
}

const AppCommandContextValue = createContext<AppCommandProviderValue | null>(
  null,
);
const AppCommandModifierHeldContext = createContext(false);

const SHORTCUT_HINT_HOLD_DELAY_MS = 700;
const CAPTURED_COMMANDS: readonly KeyboardCommandId[] = [
  "panel.previousTab",
  "panel.nextTab",
  "panel.previousNewTabItem",
  "panel.nextNewTabItem",
  ...PANE_DIRECTION_APP_COMMAND_IDS,
  "pane.focus.previous",
  "pane.focus.next",
];
const OPEN_MODAL_SELECTOR =
  '[aria-modal="true"]:not([inert]):not([inert] *):not([data-closed]), [role="dialog"]:is([data-state="open"], [data-open]):not([inert]):not([inert] *)';

function isForThisClient(binding: AppKeybinding | AppDefaultKeybinding) {
  return isAppKeybindingAvailableForClient(binding, {
    platform: browserPlatform(),
  });
}

function findBinding(
  keybindings: readonly AppKeybinding[],
  matches: (binding: AppKeybinding) => boolean,
): AppKeybinding | undefined {
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (binding && isForThisClient(binding) && matches(binding)) return binding;
  }
  return undefined;
}

function createCommandRegistry() {
  const handlers = new Map<
    KeyboardCommandId,
    Map<symbol, { handler: AppCommandHandler; priority: number; order: number }>
  >();
  const contexts = new Map<AppCommandContextKey, Set<symbol>>();
  const attemptedEvents = new WeakSet<KeyboardEvent>();
  let order = 0;
  const currentContext = (target: EventTarget | null): AppCommandContext => {
    const platform = keyboardPlatform(browserPlatform());
    const isActive = (key: AppCommandContextKey) => contexts.has(key);
    return {
      mainSurface: true,
      modalOpen: document.querySelector(OPEN_MODAL_SELECTOR) !== null,
      editableFocus: isEditableKeyboardTarget(target),
      terminalFocus:
        target instanceof HTMLElement &&
        target.closest("[data-app-terminal]") !== null,
      browserFocus: isActive("browserFocus"),
      modelPickerOpen: isActive("modelPickerOpen"),
      questionOpen: isActive("questionOpen"),
      promptAvailable: isActive("promptAvailable"),
      splitActive: isActive("splitActive"),
      webSurface: true,
      macPlatform: platform === "mac",
      windowsPlatform: platform === "windows",
      linuxPlatform: platform === "linux",
    };
  };
  const dispatch: Dispatch = (command, target) =>
    [...(handlers.get(command)?.values() ?? [])]
      .sort(
        (left, right) =>
          right.priority - left.priority || right.order - left.order,
      )
      .some((registration) => registration.handler({ target }));
  return {
    dispatch,
    registerHandler: (
      command: KeyboardCommandId,
      handler: AppCommandHandler,
      priority: number,
    ) => {
      const token = Symbol(command);
      const registrations = handlers.get(command) ?? new Map();
      order += 1;
      registrations.set(token, { handler, priority, order });
      handlers.set(command, registrations);
      return () => {
        registrations.delete(token);
        if (registrations.size === 0) handlers.delete(command);
      };
    },
    registerContext: (
      key: AppCommandContextKey,
      source: symbol,
      active: boolean,
    ) => {
      const sources = contexts.get(key) ?? new Set<symbol>();
      if (active) sources.add(source);
      else sources.delete(source);
      if (sources.size === 0) contexts.delete(key);
      else contexts.set(key, sources);
    },
    isCommandAvailable: (
      defaults: readonly AppDefaultKeybinding[],
      command: KeyboardCommandId,
      target: EventTarget | null,
    ) => {
      if (!handlers.has(command)) return false;
      const context = currentContext(target);
      return defaults.some(
        (binding) =>
          binding.command === command &&
          isForThisClient(binding) &&
          binding.when.all.every((key) => context[key]),
      );
    },
    handleKeyboardEvent: (
      keybindings: readonly AppKeybinding[],
      event: KeyboardEvent,
    ) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        attemptedEvents.has(event)
      ) {
        return false;
      }
      attemptedEvents.add(event);
      const isMac = isMacKeyboardPlatform(browserPlatform());
      let context: AppCommandContext | undefined;
      const binding = findBinding(
        keybindings,
        (candidate) =>
          matchesAppShortcut(event, candidate.shortcut, isMac) &&
          matchesAppCommandContext(
            candidate,
            (context ??= currentContext(event.target)),
          ),
      );
      if (!binding || !dispatch(binding.command, event.target)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
  };
}

function useShortcutHintModifierHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const isMac = isMacKeyboardPlatform(browserPlatform());
    let timer: ReturnType<typeof setTimeout> | null = null;
    let isHeld = false;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      isHeld = false;
      setHeld(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Control" && !(isMac && event.key === "Meta")) {
        if (!isHeld) clear();
      } else if (
        event.shiftKey ||
        event.altKey ||
        (event.key === "Meta" ? event.ctrlKey : event.metaKey)
      ) {
        if (timer === null && !isHeld) clear();
      } else if (timer === null && !isHeld) {
        timer = setTimeout(() => {
          timer = null;
          isHeld = true;
          setHeld(true);
        }, SHORTCUT_HINT_HOLD_DELAY_MS);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !(isMac && event.metaKey)) clear();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", clear);
    };
  }, [enabled]);
  return held;
}

export function AppCommandProvider({ children }: { children: ReactNode }) {
  const systemConfig = useSystemConfig();
  const { keybindings, defaults } = usePluginCommandBindings();
  const isModifierHeld = useShortcutHintModifierHeld(
    systemConfig.data?.generalSettings?.showKeyboardHints ??
      defaultAppSettings.showKeyboardHints,
  );
  const [registry] = useState(createCommandRegistry);
  const value = useMemo<AppCommandProviderValue>(
    () => ({
      keybindings,
      dispatch: registry.dispatch,
      registerContext: registry.registerContext,
      registerHandler: registry.registerHandler,
      isCommandAvailable: (command, target) =>
        registry.isCommandAvailable(defaults, command, target),
      handleKeyboardEvent: (event) =>
        registry.handleKeyboardEvent(keybindings, event),
      getShortcutCommand: (event, commands) => {
        if (event.defaultPrevented || event.isComposing || event.repeat) {
          return null;
        }
        const isMac = isMacKeyboardPlatform(browserPlatform());
        return (
          findBinding(
            keybindings,
            (binding) =>
              commands.includes(binding.command) &&
              matchesAppShortcut(event, binding.shortcut, isMac),
          )?.command ?? null
        );
      },
    }),
    [defaults, keybindings, registry],
  );

  useEffect(() => {
    const handleCapture = (event: KeyboardEvent) => {
      if (value.getShortcutCommand(event, CAPTURED_COMMANDS) !== null) {
        value.handleKeyboardEvent(event);
      }
    };
    window.addEventListener("keydown", handleCapture, true);
    window.addEventListener("keydown", value.handleKeyboardEvent);
    return () => {
      window.removeEventListener("keydown", handleCapture, true);
      window.removeEventListener("keydown", value.handleKeyboardEvent);
    };
  }, [value]);

  return (
    <AppCommandContextValue.Provider value={value}>
      <AppCommandModifierHeldContext.Provider value={isModifierHeld}>
        {children}
      </AppCommandModifierHeldContext.Provider>
    </AppCommandContextValue.Provider>
  );
}

export function useAppCommandHandler(
  command: KeyboardCommandId,
  handler: AppCommandHandler,
  priority = 0,
  enabled = true,
): void {
  const commands = useMemo(() => [command], [command]);
  useIndexedAppCommandHandlers(
    commands,
    (_index, invocation) => handler(invocation),
    priority,
    enabled,
  );
}

export function useIndexedAppCommandHandlers(
  commands: readonly KeyboardCommandId[],
  handler: (index: number, invocation: AppCommandInvocation) => boolean,
  priority = 0,
  enabled = true,
): void {
  const registerHandler = useContext(AppCommandContextValue)?.registerHandler;
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!registerHandler || !enabled) return;
    const unregister = commands.map((command, index) =>
      registerHandler(
        command,
        (invocation) => handlerRef.current(index, invocation),
        priority,
      ),
    );
    return () => unregister.forEach((dispose) => dispose());
  }, [commands, enabled, priority, registerHandler]);
}

export function useAppCommandKeyDispatch(): (event: KeyboardEvent) => boolean {
  const handle = useContext(AppCommandContextValue)?.handleKeyboardEvent;
  return (event) => handle?.(event) ?? false;
}

export function useAppCommandRunner(): AppCommandRunner {
  const value = useContext(AppCommandContextValue);
  if (value === null) throw new Error("No <AppCommandProvider>");
  return value;
}

export function useAppCommandContext(
  key: AppCommandContextKey,
  active: boolean,
): void {
  const registerContext = useContext(AppCommandContextValue)?.registerContext;
  useEffect(() => {
    if (!registerContext) return;
    const source = Symbol(key);
    registerContext(key, source, active);
    return () => registerContext(key, source, false);
  }, [active, key, registerContext]);
}

export function useAppCommandShortcuts<Command extends KeyboardCommandId>(
  commands: readonly Command[],
): ReadonlyMap<Command, AppShortcutPresentation> {
  const keybindings = useContext(AppCommandContextValue)?.keybindings;
  return useMemo(
    () =>
      new Map(
        commands.flatMap((command) => {
          const binding = findBinding(
            keybindings ?? [],
            (candidate) => candidate.command === command,
          );
          return binding
            ? [
                [
                  command,
                  presentAppShortcut(binding.shortcut, browserPlatform()),
                ] as const,
              ]
            : [];
        }),
      ),
    [commands, keybindings],
  );
}

export function useAppCommandShortcut(
  command: KeyboardCommandId,
): AppShortcutPresentation | null {
  const commands = useMemo(() => [command], [command]);
  return useAppCommandShortcuts(commands).get(command) ?? null;
}

export function useIsAppCommandModifierHeld(): boolean {
  return useContext(AppCommandModifierHeldContext);
}
