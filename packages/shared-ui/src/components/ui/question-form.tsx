import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  useQuestionFormHost,
  type QuestionShortcut,
} from "./question-form-host";
import { Button } from "./button";
import { Icon } from "./icon";
import { usePointerCoarse } from "./hooks/use-pointer-coarse";
import { cn } from "../../lib/utils";

const FREE_TEXT_MIN_HEIGHT = 84;
const FREE_TEXT_MAX_HEIGHT = 158;

interface Question {
  id: string;
  prompt: string;
  shortLabel: string;
  multiSelect: boolean;
  allowFreeText: boolean;
  options: readonly {
    value: string;
    label: string;
    description?: string;
    preview?: string;
  }[];
}

type QuestionAnswer = { selected: string[]; freeText?: string };

interface AnswerState {
  selected: string[];
  otherSelected: boolean;
  otherText: string;
}

type FormState = Record<string, AnswerState>;

function answerStateFor(formState: FormState, question: Question) {
  return (
    formState[question.id] ?? {
      selected: [],
      otherSelected: question.options.length === 0,
      otherText: "",
    }
  );
}

function validSelected(question: Question, state: AnswerState): string[] {
  const optionValues = new Set(question.options.map((option) => option.value));
  return state.selected.filter((value) => optionValues.has(value));
}

function isAnswered(question: Question, state: AnswerState): boolean {
  if (validSelected(question, state).length > 0) return true;
  return state.otherSelected && state.otherText.trim().length > 0;
}

function buildAnswer(question: Question, state: AnswerState): QuestionAnswer {
  const freeText = state.otherText.trim();
  const includeFreeText = state.otherSelected && freeText.length > 0;
  if (question.multiSelect) {
    const selected = validSelected(question, state);
    return includeFreeText ? { selected, freeText } : { selected };
  }
  if (state.otherSelected) {
    return includeFreeText ? { selected: [], freeText } : { selected: [] };
  }
  return { selected: validSelected(question, state) };
}

function updateAnswer(
  setFormState: Dispatch<SetStateAction<FormState>>,
  question: Question,
  change: (state: AnswerState) => AnswerState,
): void {
  setFormState((current) => ({
    ...current,
    [question.id]: change(answerStateFor(current, question)),
  }));
}

function toggleOption(question: Question, value: string) {
  return (state: AnswerState): AnswerState =>
    question.multiSelect
      ? {
          ...state,
          selected: state.selected.includes(value)
            ? state.selected.filter((selected) => selected !== value)
            : [...state.selected, value],
        }
      : { ...state, selected: [value], otherSelected: false };
}

function selectOther(question: Question) {
  return (state: AnswerState): AnswerState =>
    question.multiSelect
      ? { ...state, otherSelected: !state.otherSelected }
      : { ...state, selected: [], otherSelected: true };
}

function autoGrow(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(
    Math.max(element.scrollHeight, FREE_TEXT_MIN_HEIGHT),
    FREE_TEXT_MAX_HEIGHT,
  )}px`;
}

function QuestionOptionRow({
  checked,
  label,
  description,
  multiSelect,
  onSelect,
  shortcut,
}: {
  checked: boolean;
  label: string;
  description?: string;
  multiSelect: boolean;
  onSelect: () => void;
  shortcut?: QuestionShortcut;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        checked ? "bg-surface-selected" : "hover:bg-state-hover",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          multiSelect ? "rounded" : "rounded-full",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input",
        )}
      >
        {checked ? <Icon name="Check" className="size-3" aria-hidden /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <kbd
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-xs font-normal text-subtle-foreground"
        >
          {shortcut.label}
        </kbd>
      ) : null}
    </button>
  );
}

export function QuestionForm({
  questions,
  disabled,
  cancelDisabled,
  onSubmit,
  onCancel,
}: {
  questions: readonly Question[];
  disabled: boolean;
  cancelDisabled: boolean;
  onSubmit: (answers: Record<string, QuestionAnswer>) => void;
  onCancel: () => void;
}) {
  const [formState, setFormState] = useState<FormState>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const formRef = useRef<HTMLDivElement>(null);
  const freeTextRef = useRef<HTMLTextAreaElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const { shortcuts, registerChoiceHandler } = useQuestionFormHost();

  const question = questions[currentIndex] ?? null;
  const state = question ? answerStateFor(formState, question) : null;
  const isLast = currentIndex === questions.length - 1;
  const allAnswered =
    questions.length > 0 &&
    questions.every((each) =>
      isAnswered(each, answerStateFor(formState, each)),
    );

  const handleAdvance = (): void => {
    if (!isLast) {
      setCurrentIndex((index) => Math.min(index + 1, questions.length - 1));
    } else if (!disabled && allAnswered) {
      onSubmit(
        Object.fromEntries(
          questions.map((each) => [
            each.id,
            buildAnswer(each, answerStateFor(formState, each)),
          ]),
        ),
      );
    }
  };

  useLayoutEffect(() => {
    if (state?.otherSelected) autoGrow(freeTextRef.current);
  }, [question?.id, state?.otherSelected, state?.otherText]);

  useEffect(() => {
    if (disabled || question === null) return;
    return registerChoiceHandler((index) => {
      const option = question.options[index];
      if (option) {
        updateAnswer(
          setFormState,
          question,
          toggleOption(question, option.value),
        );
        formRef.current?.focus();
        return true;
      }
      if (
        index !== question.options.length ||
        question.options.length === 0 ||
        !question.allowFreeText
      ) {
        return false;
      }
      updateAnswer(setFormState, question, selectOther(question));
      return true;
    });
  }, [disabled, question, registerChoiceHandler]);

  if (!question || !state) return null;

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          disabled
        )
          return;
        event.preventDefault();
        handleAdvance();
      }}
      className="flex max-h-[calc(100dvh-6rem)] min-h-0 flex-col text-xs text-muted-foreground"
    >
      {questions.length > 1 ? (
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {questions.map((each, index) => (
              <div
                key={each.id}
                className={cn(
                  "relative inline-flex h-7 shrink-0 items-center rounded-md",
                  index === currentIndex
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-state-hover",
                )}
              >
                <button
                  type="button"
                  onClick={() => setCurrentIndex(index)}
                  aria-pressed={index === currentIndex}
                  title={each.prompt}
                  className="flex h-full min-w-0 items-center rounded-md px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span
                    className={cn(
                      "truncate text-xs",
                      isAnswered(each, answerStateFor(formState, each))
                        ? "line-through"
                        : undefined,
                    )}
                    style={{ maxWidth: "180px" }}
                  >
                    {each.shortLabel}
                  </span>
                </button>
              </div>
            ))}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {currentIndex + 1} of {questions.length}
          </span>
        </div>
      ) : null}
      <div className="min-h-0 touch-pan-y overflow-y-auto overscroll-contain">
        <fieldset disabled={disabled} className="min-w-0">
          <legend className="sr-only">{question.prompt}</legend>
          {question.prompt ? (
            <div className="text-sm font-semibold text-foreground">
              {question.prompt}
            </div>
          ) : null}
          <div className="mt-2 space-y-0.5">
            {question.options.map((option, index) => {
              const checked = state.selected.includes(option.value);
              return (
                <div key={option.value}>
                  <QuestionOptionRow
                    checked={checked}
                    label={option.label}
                    description={option.description}
                    multiSelect={question.multiSelect}
                    onSelect={() =>
                      updateAnswer(
                        setFormState,
                        question,
                        toggleOption(question, option.value),
                      )
                    }
                    shortcut={shortcuts.get(String(index))}
                  />
                  {checked && option.preview ? (
                    <pre
                      className="mx-2.5 mb-1 mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-raised px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground"
                      style={{ maxHeight: "220px" }}
                    >
                      {option.preview}
                    </pre>
                  ) : null}
                </div>
              );
            })}
            {question.allowFreeText && question.options.length > 0 ? (
              <QuestionOptionRow
                checked={state.otherSelected}
                label="Other…"
                multiSelect={question.multiSelect}
                onSelect={() =>
                  updateAnswer(setFormState, question, selectOther(question))
                }
                shortcut={shortcuts.get(String(question.options.length))}
              />
            ) : null}
          </div>
          {state.otherSelected ? (
            <textarea
              ref={freeTextRef}
              aria-label={`${question.shortLabel} answer`}
              value={state.otherText}
              rows={1}
              autoFocus={!isPointerCoarse}
              autoComplete="off"
              onChange={(event) => {
                const otherText = event.target.value;
                updateAnswer(setFormState, question, (current) => ({
                  ...current,
                  otherText,
                }));
                autoGrow(event.target);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.key !== "Enter" ||
                  (!event.metaKey && !event.ctrlKey)
                ) {
                  return;
                }
                event.preventDefault();
                handleAdvance();
              }}
              placeholder="Type your own answer…"
              className="mt-2 w-full resize-none overflow-y-auto rounded-md border border-border bg-surface-raised px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
              style={{
                minHeight: `${FREE_TEXT_MIN_HEIGHT}px`,
                maxHeight: `${FREE_TEXT_MAX_HEIGHT}px`,
              }}
            />
          ) : null}
        </fieldset>
      </div>
      <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          {currentIndex > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setCurrentIndex((index) => Math.max(index - 1, 0))}
            >
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={disabled || (isLast && !allAnswered)}
            onClick={handleAdvance}
          >
            {disabled ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {isLast ? "Submit answer" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
