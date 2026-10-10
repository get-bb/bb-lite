import { useCallback, useMemo, useState } from "react";
import { callOp, threads, useOp } from "@bb/plugin/app";
import { showMutationErrorToast } from "@bb/app-kit/lib/mutation-errors";
import {
  buildSessionOptionMenuSections,
  splitSessionOptionsByPlacement,
  threadSessionOptionViews,
  type SessionOptionChoice,
  type SessionOptionChoices,
  type SessionOptionMenuSection,
  type SessionOptionView,
} from "../components/pickers/SessionOptionsMenu";

interface OptimisticChoices {
  threadId: string;
  options: readonly SessionOptionView[];
  choices: SessionOptionChoices;
}

const NO_CHOICES: SessionOptionChoices = {};
const NO_OPTIONS: readonly SessionOptionView[] = [];

export interface ThreadSessionOptionChoices {
  footerOptions: readonly SessionOptionView[];
  pickerSections: readonly SessionOptionMenuSection[];
  choices: SessionOptionChoices;
  choose: (optionId: string, value: SessionOptionChoice) => void;
}

export function useThreadSessionOptionChoices(
  threadId: string,
): ThreadSessionOptionChoices {
  const state = useOp(threads.sessionOptions, { threadId });
  const data = state.data;
  const options = useMemo(
    () =>
      data === undefined
        ? NO_OPTIONS
        : threadSessionOptionViews(data.options, data.selections),
    [data],
  );
  const [optimistic, setOptimistic] = useState<OptimisticChoices>({
    threadId,
    options,
    choices: NO_CHOICES,
  });
  const choices =
    optimistic.threadId === threadId && optimistic.options === options
      ? optimistic.choices
      : NO_CHOICES;

  const choose = useCallback(
    (optionId: string, value: SessionOptionChoice) => {
      setOptimistic({
        threadId,
        options,
        choices: { ...choices, [optionId]: value },
      });
      callOp(threads.updateSessionOptions, {
        threadId,
        set: { [optionId]: value },
      }).catch((error: unknown) => {
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to change the agent option.",
        });
        setOptimistic((current) => {
          if (
            current.threadId !== threadId ||
            current.choices[optionId] !== value
          ) {
            return current;
          }
          const { [optionId]: _failed, ...rest } = current.choices;
          return { ...current, choices: rest };
        });
      });
    },
    [choices, options, threadId],
  );

  const placement = useMemo(
    () => splitSessionOptionsByPlacement(options),
    [options],
  );
  const pickerSections = useMemo(
    () => buildSessionOptionMenuSections(placement.picker, choices),
    [choices, placement.picker],
  );

  return {
    footerOptions: placement.footer,
    pickerSections,
    choices,
    choose,
  };
}
