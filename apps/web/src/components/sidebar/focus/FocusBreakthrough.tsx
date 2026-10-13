/**
 * Under the "Work hidden" chip: what an escalation rule lets through Focus.
 * Folded, it is one calm row ("Breaks through Focus" and how many need you,
 * like a folded folder); unfolded, each item gets its usual row under the
 * name of the folder it sits in, and nothing else from that folder. Mount it
 * inside the tree's `MappedIndexContext`.
 */
import { ChevronRightIcon, ZapIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "~/lib/utils";
import { renderHomeThreadRow, type HomeThreadRowContext } from "../HomeThreadRow";
import { mergeRollups } from "../sections/homeStatus";
import { ContainerItems } from "../sections/HomeItems";
import { MappedStrip } from "../sections/MappedStrip";
import { RollupMarker } from "../sections/StatusMarkers";
import type { BreakthroughGroup } from "./breakthrough";

export function FocusBreakthrough(props: {
  groups: readonly BreakthroughGroup[];
  rowContext: HomeThreadRowContext;
}) {
  const [open, setOpen] = useState(false);
  if (props.groups.length === 0) return null;
  const rollup = mergeRollups(props.groups.map((group) => group.rollup));
  return (
    <ul aria-label="Breaks through Focus" className="flex flex-col gap-px pt-2">
      <li>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <ZapIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Breaks through Focus</span>
          <RollupMarker rollup={rollup} />
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
        </button>
      </li>
      {open
        ? props.groups.map((group) => (
            <Fragment key={group.key}>
              <li className="px-2.5 pt-1.5 text-2xs font-medium text-sidebar-muted-foreground/60">
                {group.label}
              </li>
              <MappedStrip items={group.contents.mapped} containerKey={group.key} />
              <ContainerItems
                contents={group.contents}
                place={group.place}
                renderThread={(thread) =>
                  renderHomeThreadRow(thread, group.projectName, props.rowContext, group.place)
                }
              />
            </Fragment>
          ))
        : null}
    </ul>
  );
}
