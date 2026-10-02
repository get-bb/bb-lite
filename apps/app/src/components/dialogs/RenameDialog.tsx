import { capitalize } from "@bb/thread-view";
import { useRef, useState, type RefObject } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Input } from "@bb/shared-ui/input";

interface RenameDialogProps {
  target: { key: string; name: string } | null;
  entityLabel: string;
  autoCapitalize?: "words" | "sentences";
  compact?: boolean;
  shellClassName?: string;
  pending: boolean;
  description?: string;
  errorMessage?: string | null;
  maxLength?: number;
  onOpenChange: (open: boolean) => void;
  onRename: (name: string) => void;
}

export function RenameDialog(props: RenameDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  return (
    <Dialog open={props.target !== null} onOpenChange={props.onOpenChange}>
      <DialogContent
        className={props.shellClassName}
        onOpenAutoFocus={(event) => {
          if (returnFocusRef.current === undefined) {
            const active = document.activeElement;
            returnFocusRef.current =
              active instanceof HTMLElement && active !== document.body
                ? active
                : null;
          }
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        onAfterCloseAutoFocus={() => {
          const returnFocus = returnFocusRef.current;
          returnFocusRef.current = undefined;
          if (
            returnFocus?.isConnected &&
            returnFocus.closest('[aria-hidden="true"], [inert]') === null
          ) {
            returnFocus.focus({ preventScroll: true });
          }
        }}
      >
        {props.target ? (
          <RenameForm
            key={props.target.key}
            {...props}
            name={props.target.name}
            inputRef={inputRef}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  name,
  entityLabel,
  autoCapitalize,
  compact = false,
  pending,
  description,
  errorMessage,
  maxLength,
  onRename,
  inputRef,
}: RenameDialogProps & {
  name: string;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [nextName, setNextName] = useState(name);
  const [empty, setEmpty] = useState(false);
  const message = empty
    ? `${capitalize(entityLabel)} name cannot be empty.`
    : errorMessage;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename {entityLabel}</DialogTitle>
        <DialogDescription>
          {description ?? `Choose a new name for this ${entityLabel}.`}
        </DialogDescription>
      </DialogHeader>
      <form
        className={compact ? "space-y-3" : "space-y-4"}
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const trimmed = nextName.trim();
          if (trimmed) onRename(trimmed);
          else setEmpty(true);
        }}
      >
        <div className={compact ? "space-y-1.5" : "space-y-2"}>
          <Input
            ref={inputRef}
            aria-label={`${capitalize(entityLabel)} name`}
            value={nextName}
            maxLength={maxLength}
            autoCapitalize={autoCapitalize}
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setNextName(event.target.value);
              setEmpty(false);
            }}
          />
          {message ? (
            <p className="text-sm text-destructive">{message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            Rename {entityLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
