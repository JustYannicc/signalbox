/**
 * Row markers for the Home tree, in the Pipeline's vocabulary
 * (`threadStatusDisplay`). Every one reads without hovering and explains
 * itself in a tooltip. Nothing animates.
 */
import { LockIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { firstName } from "../../multiplayer/multiplayerModel";
import { findPerson } from "../../multiplayer/teamThreads";
import { THREAD_STATUS_DISPLAY, type ThreadDisplayStatus } from "../../threadStatusDisplay";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { StatusRollup } from "./homeStatus";
import type { ItemScope } from "./useItemScope";

/** Sits above a row's stretched button so its tooltip still opens. */
function Marker(props: {
  label: string;
  tooltip: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={props.label}
            className={cn(
              "relative z-10 inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              props.className,
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Icon and the Pipeline's label ("Approval", "Working", …). */
export function StatusMarker(props: { status: ThreadDisplayStatus; tooltip?: string }) {
  const info = THREAD_STATUS_DISPLAY[props.status];
  return (
    <Marker
      label={info.label}
      tooltip={props.tooltip ?? info.description}
      className={info.className}
    >
      <info.icon className="size-3.5" />
      <span>{info.label}</span>
    </Marker>
  );
}

/** Someone other than you is needed next. */
export function WaitingOnMarker(props: { personId: string }) {
  const name = firstName(findPerson(props.personId)?.name ?? "someone");
  const info = THREAD_STATUS_DISPLAY.waiting;
  return (
    <Marker label={`Waiting on ${name}`} tooltip={`Waiting on ${name}`} className={info.className}>
      <info.icon className="size-3.5" />
      <span>{name}</span>
    </Marker>
  );
}

export function MentionMarker(props: { personId: string }) {
  const name = firstName(findPerson(props.personId)?.name ?? "Someone");
  return (
    <Marker
      label={`${name} mentioned you`}
      tooltip={`${name} mentioned you`}
      className={THREAD_STATUS_DISPLAY.input.className}
    >
      <span className="leading-none font-semibold">@</span>
    </Marker>
  );
}

/** Only departures from the container's default scope get a marker. */
export function ScopeMarker(props: { scope: ItemScope }) {
  const { deviation, othersCount } = props.scope;
  if (deviation === null) return null;
  if (deviation === "private-in-shared") {
    return (
      <Marker
        label="Private"
        tooltip="Private · only you"
        className="text-sidebar-muted-foreground"
      >
        <LockIcon className="size-3" />
      </Marker>
    );
  }
  const people = `${othersCount} ${othersCount === 1 ? "person" : "people"}`;
  return (
    <Marker
      label={`Shared with ${people}`}
      tooltip={`Shared with ${people}`}
      className="text-sidebar-muted-foreground"
    >
      <UsersIcon className="size-3" />
      {othersCount > 0 ? <span>{othersCount}</span> : null}
    </Marker>
  );
}

/** Folder summary: only what needs you (Failed included), as icon + count. */
export function RollupMarker(props: { rollup: StatusRollup }) {
  const { needsYou, mostUrgent } = props.rollup;
  if (needsYou === 0) return null;
  const info = THREAD_STATUS_DISPLAY[mostUrgent ?? "input"];
  const text = `${needsYou} need${needsYou === 1 ? "s" : ""} you`;
  return (
    <Marker label={text} tooltip={text} className={info.className}>
      <info.icon className="size-3.5" />
      <span className="tabular-nums">{needsYou}</span>
    </Marker>
  );
}
