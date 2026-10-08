import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { cn } from "@bb/shared-ui/lib/utils";
import type { ReactNode } from "react";
import type { Viewer } from "../../src/dashboard-types.js";
import { post } from "../data";
import { Mark } from "./brand";

export function Avatar({
  name,
  url,
  className,
}: {
  name: string;
  url: string | null;
  className?: string;
}) {
  const shape = cn("size-6 shrink-0 rounded-full", className);
  if (url !== null) {
    return (
      <img src={url} alt="" referrerPolicy="no-referrer" className={shape} />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        shape,
        "grid place-items-center bg-secondary text-2xs font-semibold",
      )}
    >
      {initial}
    </span>
  );
}

function UserMenu({ viewer }: { viewer: Viewer }) {
  const signOut = async () => {
    await post("/logout").catch(() => null);
    window.location.assign("/login");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-2 px-1.5">
          <Avatar name={viewer.name} url={viewer.avatarUrl} />
          <span className="max-w-40 truncate text-sm font-normal">
            {viewer.name}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          @{viewer.login}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Shell({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-border-hairline bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-5">
          <a href="/" className="flex items-center gap-2.5">
            <Mark className="h-[18px] w-auto" />
            <span className="text-sm font-semibold tracking-tight">
              bb-next
            </span>
          </a>
          <UserMenu viewer={viewer} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-20 pt-10">
        {children}
      </main>
    </div>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-10 first:mt-0">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {description === undefined ? null : (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border-hairline bg-surface-raised",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="mt-3 text-sm text-destructive-text">
      {message}
    </p>
  );
}

export function AddressField({
  id,
  value,
  baseHost,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  baseHost: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex h-9 min-w-0 flex-1 basis-56 items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
      <input
        id={id}
        value={value}
        disabled={disabled}
        required
        maxLength={32}
        pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="my-server"
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        className="h-full min-w-0 flex-1 bg-transparent pl-3 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <span className="shrink-0 select-none pr-3 text-sm text-muted-foreground">
        .{baseHost}
      </span>
    </div>
  );
}
