import { useId, type ComponentProps, type ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Label } from "@bb/shared-ui/label";
import bbLogoUrl from "../../../../../assets/bb-logo.svg";

export function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="flex h-full w-full flex-col items-center overflow-y-auto bg-background px-4 py-10 text-foreground">
      <div className="my-auto flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div role="img" aria-label="bb" className="h-12 w-14 select-none">
            <img
              src={bbLogoUrl}
              alt=""
              aria-hidden
              draggable={false}
              className="size-full object-contain dark:invert"
            />
          </div>
          <div className="space-y-1">
            <h1 className="text-base font-semibold text-foreground">{title}</h1>
            {description ? (
              <p className="text-sm leading-snug text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      {children}
    </div>
  );
}

export function AuthField({
  label,
  hint,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & {
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-subtle-foreground/75">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-destructive" role="alert">
      {children}
    </p>
  );
}

export function AuthSpinner({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Icon name="Spinner" className="size-4 animate-spin" />
      {label}
    </div>
  );
}
