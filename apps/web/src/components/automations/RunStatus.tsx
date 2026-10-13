/**
 * Run and step status in the hues the thread sidebar uses everywhere: sky for
 * working, amber when it needs you, red for failed, green for done. The words
 * come from client-runtime so every client says the same thing.
 */
import {
  DISPLAY_STATUS_LABEL,
  type AutomationDisplayStatus,
} from "@t3tools/client-runtime/automations/status";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  HourglassIcon,
  MessageCircleQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

const DISPLAY: Record<AutomationDisplayStatus, { icon: LucideIcon; className: string }> = {
  working: { icon: CircleDashedIcon, className: "text-info" },
  needsYou: { icon: MessageCircleQuestionIcon, className: "text-warning-foreground" },
  waiting: { icon: HourglassIcon, className: "text-muted-foreground" },
  failed: { icon: CircleAlertIcon, className: "text-error" },
  done: { icon: CircleCheckIcon, className: "text-success" },
  cancelled: { icon: CircleSlashIcon, className: "text-muted-foreground" },
};

export function StatusIcon(props: { status: AutomationDisplayStatus; className?: string }) {
  const display = DISPLAY[props.status];
  return (
    <display.icon
      aria-hidden
      className={cn("size-4 shrink-0", display.className, props.className)}
    />
  );
}

/**
 * A row's status marker, read without hovering: icon and word in the status
 * hue, like a Pipeline row. Done shows nothing; there is nothing to see.
 */
export function RunStatusMarker(props: { status: AutomationDisplayStatus | null }) {
  if (!props.status || props.status === "done") return null;
  const display = DISPLAY[props.status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
        display.className,
      )}
    >
      <display.icon aria-hidden className="size-3.5 shrink-0" />
      {DISPLAY_STATUS_LABEL[props.status]}
    </span>
  );
}

/** Icon plus word, e.g. in the run picker and the details panel. */
export function StatusLabel(props: { status: AutomationDisplayStatus }) {
  const display = DISPLAY[props.status];
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", display.className)}>
      <display.icon aria-hidden className="size-3.5 shrink-0" />
      {DISPLAY_STATUS_LABEL[props.status]}
    </span>
  );
}
