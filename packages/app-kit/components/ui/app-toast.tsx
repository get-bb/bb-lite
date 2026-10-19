import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast as sonnerToast, type Action } from "sonner";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

const TONE_ICONS = {
  success: "CircleCheck",
  warning: "AlertTriangle",
  error: "AlertCircle",
  loading: "Loading",
};

type AppToastTone = keyof typeof TONE_ICONS;

interface AppToastOptions {
  action?: Action;
  cancel?: Action;
  description?: ReactNode;
  duration?: number;
  id?: number | string;
}

const LINK_BUTTON_CLASS =
  "h-auto shrink-0 px-0 py-0 text-xs text-muted-foreground underline underline-offset-4";

function AppToastActionButton({
  action,
  id,
  primary,
}: {
  action: Action;
  id: number | string;
  primary: boolean;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className={LINK_BUTTON_CLASS}
      onClick={(event) => {
        action.onClick(event);
        if (!primary || !event.defaultPrevented) sonnerToast.dismiss(id);
      }}
    >
      {action.label}
    </Button>
  );
}

function AppToastOverflowText({
  className,
  content,
  testId,
}: {
  className?: string;
  content: ReactNode;
  testId: string;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const measure = () => {
      setTruncated(
        body.scrollHeight - body.clientHeight > 1 ||
          body.scrollWidth - body.clientWidth > 1,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [content]);

  return (
    <div className="min-w-0 w-full">
      <div
        ref={bodyRef}
        data-testid={testId}
        className={cn(
          "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
          !expanded && "line-clamp-4",
          className,
        )}
      >
        {content}
      </div>
      {truncated && !expanded ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className={LINK_BUTTON_CLASS}
          onClick={() => setExpanded(true)}
        >
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function AppToastContent({
  action,
  cancel,
  description,
  id,
  title,
  tone,
}: AppToastOptions & {
  id: number | string;
  title: ReactNode;
  tone: AppToastTone;
}) {
  const hasActions = action !== undefined || cancel !== undefined;
  return (
    <div className="w-[var(--width,356px)] max-w-[calc(100vw-32px)] shrink-0 rounded-md border border-border bg-popover px-4 py-3 text-popover-foreground shadow-sm max-[600px]:w-[calc(100vw-32px)]">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-foreground">
          <Icon
            name={TONE_ICONS[tone]}
            className={cn("size-4", tone === "loading" && "animate-spin")}
            style={{ margin: 0 }}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <AppToastOverflowText
              className="text-sm font-medium leading-5"
              content={title}
              testId="app-toast-title"
            />
          </div>
          {description || hasActions ? (
            <div className="mt-0.5 flex min-w-0 flex-col items-start gap-2 text-xs leading-5 text-muted-foreground">
              {description ? (
                <AppToastOverflowText
                  content={description}
                  testId="app-toast-description"
                />
              ) : null}
              {hasActions ? (
                <div className="flex flex-wrap gap-2">
                  {action ? (
                    <AppToastActionButton action={action} id={id} primary />
                  ) : null}
                  {cancel ? (
                    <AppToastActionButton
                      action={cancel}
                      id={id}
                      primary={false}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-mr-1 -mt-1 size-6 shrink-0 text-muted-foreground"
          aria-label="Dismiss notification"
          onClick={() => sonnerToast.dismiss(id)}
        >
          <Icon
            name="X"
            className="size-3.5"
            style={{ margin: 0 }}
            aria-hidden
          />
        </Button>
      </div>
    </div>
  );
}

function show(tone: AppToastTone) {
  return (title: ReactNode, options: AppToastOptions = {}) =>
    sonnerToast.custom(
      (id) => (
        <AppToastContent {...options} id={id} title={title} tone={tone} />
      ),
      {
        ...(options.id === undefined ? {} : { id: options.id }),
        className: "bb-app-toast",
        dismissible: true,
        duration: options.duration ?? (tone === "loading" ? Infinity : 4000),
      },
    );
}

export const appToast = {
  dismiss: sonnerToast.dismiss,
  error: show("error"),
  loading: show("loading"),
  success: show("success"),
  warning: show("warning"),
};
