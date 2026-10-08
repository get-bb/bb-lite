import { useState, type ComponentProps } from "react";
import type { User } from "@bb/domain";
import { cn } from "@bb/shared-ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { userHue, userInitials } from "../../hooks/queries/user-queries";

export type UserAvatarSize = "xs" | "sm" | "md";

type TooltipSide = ComponentProps<typeof TooltipContent>["side"];

const AVATAR_SIZE_CLASS: Record<UserAvatarSize, string> = {
  xs: "size-4 text-[0.5rem]",
  sm: "size-5 text-2xs",
  md: "size-6 text-2xs",
};

const AVATAR_BASE_CLASS =
  "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium leading-none";

function UserAvatarFace({
  user,
  size,
  className,
}: {
  user: User;
  size: UserAvatarSize;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const { avatarUrl } = user;
  if (avatarUrl !== null && avatarUrl !== failedUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        aria-hidden
        draggable={false}
        referrerPolicy="no-referrer"
        data-user-avatar={user.id}
        className={cn(
          AVATAR_BASE_CLASS,
          AVATAR_SIZE_CLASS[size],
          "bg-muted object-cover",
          className,
        )}
        onError={() => setFailedUrl(avatarUrl)}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-user-avatar={user.id}
      className={cn(
        AVATAR_BASE_CLASS,
        AVATAR_SIZE_CLASS[size],
        "text-white",
        className,
      )}
      style={{ backgroundColor: `hsl(${userHue(user.id)} 55% 45%)` }}
    >
      {userInitials(user.name)}
    </span>
  );
}

export function UserAvatar({
  user,
  size = "sm",
  showTooltip = true,
  tooltipSide,
  className,
}: {
  user: User;
  size?: UserAvatarSize;
  showTooltip?: boolean;
  tooltipSide?: TooltipSide;
  className?: string;
}) {
  if (!showTooltip) {
    return <UserAvatarFace user={user} size={size} className={className} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={user.name} className="inline-flex">
          <UserAvatarFace user={user} size={size} className={className} />
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{user.name}</TooltipContent>
    </Tooltip>
  );
}

export function UserAvatarStack({
  users,
  max = 3,
  size = "sm",
  orientation = "horizontal",
  label,
  tooltipSide,
  ringClassName = "ring-background",
  className,
}: {
  users: readonly User[];
  max?: number;
  size?: UserAvatarSize;
  orientation?: "horizontal" | "vertical";
  label?: string;
  tooltipSide?: TooltipSide;
  ringClassName?: string;
  className?: string;
}) {
  if (users.length === 0) return null;
  const visible = users.slice(0, Math.max(1, max));
  const overflow = users.length - visible.length;
  const names = users.map((user) => user.name);
  const summary = names.join(", ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label ? `${label}: ${summary}` : summary}
          data-user-avatar-stack=""
          className={cn(
            "inline-flex shrink-0 items-center",
            orientation === "vertical"
              ? "flex-col -space-y-1.5"
              : "-space-x-1.5",
            className,
          )}
        >
          {visible.map((user) => (
            <UserAvatarFace
              key={user.id}
              user={user}
              size={size}
              className={cn("ring-2", ringClassName)}
            />
          ))}
          {overflow > 0 ? (
            <span
              aria-hidden
              className={cn(
                AVATAR_BASE_CLASS,
                AVATAR_SIZE_CLASS[size],
                "bg-muted text-muted-foreground ring-2",
                ringClassName,
              )}
            >
              +{overflow}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        <div className="flex flex-col gap-0.5">
          {label ? <span className="opacity-70">{label}</span> : null}
          {users.map((user) => (
            <span key={user.id}>{user.name}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
