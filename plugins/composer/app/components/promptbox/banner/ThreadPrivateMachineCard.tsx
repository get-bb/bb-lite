import { Icon } from "@bb/shared-ui/icon";
import { PromptStackCard } from "./PromptStackCard";

export function ThreadPrivateMachineCard({ message }: { message: string }) {
  return (
    <PromptStackCard ariaLabel="Private machine" className="overflow-hidden">
      <div
        role="status"
        className="flex min-h-8 items-start gap-1.5 px-3 py-1.5 text-xs"
      >
        <Icon
          name="Lock"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 text-muted-foreground">{message}</span>
      </div>
    </PromptStackCard>
  );
}
