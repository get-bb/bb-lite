import { capitalize } from "@bb/thread-view";
import { useState, type RefObject } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Input } from "@bb/shared-ui/input";
import { RenameDialog as RenameDialogShell } from "@bb/shared-ui/rename-dialog";

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
  const { target } = props;
  return (
    <RenameDialogShell
      open={target !== null}
      onOpenChange={props.onOpenChange}
      shellClassName={props.shellClassName}
    >
      {(inputRef) =>
        target ? (
          <RenameForm
            key={target.key}
            {...props}
            name={target.name}
            inputRef={inputRef}
          />
        ) : null
      }
    </RenameDialogShell>
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
