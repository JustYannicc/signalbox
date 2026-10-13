/**
 * "Coordinates …" on agent pages: what the agent runs at its level, so it
 * reads as the place to go for work there. It spins up tasks and keeps the
 * threads, automations and places at its level moving; the work itself
 * happens in those threads. Counts in the trigger, a short list per kind in
 * the popover, each row linking to the thing.
 */
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { TOP_LEVEL, type LevelKey } from "./levels";
import { useLevelContents, type LevelEntry } from "./useLevelContents";

const VISIBLE_ROWS = 4;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function EntryLink(props: { entry: LevelEntry; level: LevelKey }) {
  const { entry } = props;
  const className =
    "flex min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-accent focus-visible:bg-accent";
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-foreground">{entry.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{entry.detail}</span>
    </>
  );
  const { target } = entry;
  switch (target.kind) {
    case "shared":
      return (
        <Link to="/shared/$threadId" params={{ threadId: target.threadId }} className={className}>
          {body}
        </Link>
      );
    case "room":
      return (
        <Link to="/rooms/$roomId" params={{ roomId: target.roomId }} className={className}>
          {body}
        </Link>
      );
    case "thread":
      return (
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(target.ref)}
          className={className}
        >
          {body}
        </Link>
      );
    case "automation":
      return (
        <Link
          to="/home/automations/$automationId"
          params={{ automationId: target.automationId }}
          className={className}
        >
          {body}
        </Link>
      );
    case "place":
      return (
        <Link
          to="/spaces"
          search={{ mapping: target.mappingId, at: props.level }}
          className={className}
        >
          {body}
        </Link>
      );
  }
}

function Group(props: { title: string; entries: readonly LevelEntry[]; level: LevelKey }) {
  if (props.entries.length === 0) return null;
  const hidden = props.entries.length - VISIBLE_ROWS;
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-1.5 text-xs font-medium text-muted-foreground">
        {props.title} <span className="tabular-nums">{props.entries.length}</span>
      </h3>
      <ul className="flex flex-col">
        {props.entries.slice(0, VISIBLE_ROWS).map((entry) => (
          <li key={entry.id}>
            <EntryLink entry={entry} level={props.level} />
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="px-1.5 text-xs text-muted-foreground">and {hidden} more in Home</p>
      ) : null}
    </section>
  );
}

export function LevelCoordinates(props: {
  level: LevelKey | null;
  /** Folder path, e.g. "Work › Northwind team". */
  levelLabel: string;
  agentName: string;
}) {
  const contents = useLevelContents(props.level);
  const { level } = props;
  if (level === null) return null;
  const counts = [
    contents.threads.length > 0 ? plural(contents.threads.length, "thread", "threads") : null,
    contents.automations.length > 0
      ? plural(contents.automations.length, "automation", "automations")
      : null,
    contents.places.length > 0 ? plural(contents.places.length, "place", "places") : null,
  ].filter((part) => part !== null);

  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="xs" variant="ghost" className="min-w-0 max-sm:hidden" />}
      >
        <span className="truncate">
          Coordinates {counts.length > 0 ? counts.join(", ") : "nothing yet"}
        </span>
        <ChevronDownIcon aria-hidden />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground text-pretty">
            {props.agentName} coordinates the work{" "}
            {level === TOP_LEVEL ? (
              "at the top level"
            ) : (
              <>
                in <span className="text-foreground">{props.levelLabel}</span>
              </>
            )}
            : it spins up tasks, keeps them moving and runs the automations here. The work itself
            happens in each thread; folders inside have agents of their own.
          </p>
          {counts.length === 0 ? (
            <p className="text-muted-foreground">Nothing lives here yet.</p>
          ) : (
            <>
              <Group title="Threads" entries={contents.threads} level={level} />
              <Group title="Automations" entries={contents.automations} level={level} />
              <Group title="Places" entries={contents.places} level={level} />
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
