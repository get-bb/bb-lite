import { useId, type ComponentProps } from "react";
import type { UserRole } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Label } from "@bb/shared-ui/label";
import { cn } from "@bb/shared-ui/lib/utils";
import { useClipboardCopy } from "@bb/app-kit/lib/clipboard";

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  owner: "Owner",
  member: "Member",
};

export function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function PeopleField({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & { label: string }) {
  const id = useId();
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

export function ShareLinkField({
  label,
  url,
  expiresAt,
}: {
  label: string;
  url: string;
  expiresAt: number;
}) {
  const id = useId();
  const { copied, copy } = useClipboardCopy({
    text: url,
    successMessage: "Link copied",
  });
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={id}
          readOnly
          value={url}
          className="min-w-0 flex-1 font-mono text-xs"
          onFocus={(event) => event.target.select()}
        />
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={() => void copy()}
        >
          <Icon name={copied ? "Check" : "Copy"} className="size-3.5" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground/75">
        Works once. Expires {formatExpiry(expiresAt)}.
      </p>
    </div>
  );
}

export interface SharedLink {
  title: string;
  description: string;
  url: string;
  expiresAt: number;
}

export function ShareLinkDialog({
  link,
  onClose,
}: {
  link: SharedLink | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {link ? (
          <>
            <DialogHeader>
              <DialogTitle>{link.title}</DialogTitle>
              <DialogDescription>{link.description}</DialogDescription>
            </DialogHeader>
            <ShareLinkField
              label="Link"
              url={link.url}
              expiresAt={link.expiresAt}
            />
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
