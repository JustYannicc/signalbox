/**
 * People in multiplayer threads: initials on a soft theme-token gradient, so a
 * person never reads as the assistant's drawn avatar. Agents get a square bot
 * tile instead of a disc.
 */
import { BotIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { personInitials, type AvatarGradient, type TeamPerson } from "./multiplayerModel";

const GRADIENT_CLASS: Record<AvatarGradient, string> = {
  sky: "from-info/45 to-info/10",
  mint: "from-success/45 to-success/10",
  amber: "from-warning/45 to-warning/10",
  rose: "from-destructive/40 to-destructive/10",
};

const SIZE_CLASS = {
  /** 14px, for overlapped stacks on dense rows; one initial. */
  "2xs": "size-3.5 text-4xs",
  /** Sidebar rows: one initial, no room for two. */
  xs: "size-4 text-4xs",
  sm: "size-6 text-3xs",
  md: "size-8 text-xs",
} as const;

export type AvatarSize = keyof typeof SIZE_CLASS;

export function PersonAvatar(props: {
  person: TeamPerson;
  size?: AvatarSize;
  /** Ring color that separates stacked avatars from what is behind them. */
  ringClassName?: string;
}) {
  const size = props.size ?? "md";
  const initials = personInitials(props.person.name);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-linear-to-br font-semibold text-foreground",
        GRADIENT_CLASS[props.person.gradient],
        SIZE_CLASS[size],
        props.ringClassName,
      )}
    >
      {size === "xs" || size === "2xs" ? initials.slice(0, 1) : initials}
    </span>
  );
}

export function AgentAvatar(props: { size?: AvatarSize }) {
  const size = props.size ?? "md";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
        SIZE_CLASS[size],
      )}
    >
      <BotIcon className={size === "md" ? "size-4" : size === "2xs" ? "size-2.5" : "size-3"} />
    </span>
  );
}

/** Overlapping avatars, capped at `max` with a "+N" tail. */
export function AvatarStack(props: {
  people: readonly TeamPerson[];
  max?: number;
  size?: AvatarSize;
  ringClassName?: string;
  label?: string;
}) {
  const max = props.max ?? 3;
  const shown = props.people.slice(0, max);
  const overflow = props.people.length - shown.length;
  const size = props.size ?? "sm";
  return (
    <span
      role="img"
      aria-label={props.label ?? props.people.map((person) => person.name).join(", ")}
      className={cn(
        "flex shrink-0 items-center",
        size === "xs" || size === "2xs" ? "-space-x-1" : "-space-x-1.5",
      )}
    >
      {shown.map((person) => (
        <PersonAvatar
          key={person.id}
          person={person}
          size={size}
          ringClassName={props.ringClassName ?? "ring-2 ring-background"}
        />
      ))}
      {overflow > 0 ? (
        <span
          aria-hidden
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground",
            SIZE_CLASS[size],
            props.ringClassName ?? "ring-2 ring-background",
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
