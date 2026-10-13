/**
 * Escalation in the Home tree. Focus drops whole sections out of sight, but
 * an escalation rule (`levels/escalation.ts`) lets matching items through:
 * those items, and only those, come back under the "Work hidden" chip, grouped
 * by the folder they sit in. Nothing else about a hidden folder shows: no
 * counts, no progress. The rail bell counts the same items (`useNeedsYouCount`).
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { LevelKey } from "../../levels/levels";
import { homeThreadKey } from "../useHomeSidebarData";
import {
  roomNeedsYou,
  rollupForContents,
  type ContainerContents,
} from "../sections/containerContents";
import type { StatusRollup } from "../sections/homeStatus";
import { statusForThread } from "../sections/homeStatus";
import type { RowPlace } from "../sections/HomeItems";
import { signalsForTeamThread } from "../sections/itemSignals";
import type { ThreadDisplayStatus } from "../../threadStatusDisplay";
import { breaksThroughFocus } from "./focusLevels";

/** A folder Focus hides, with everything in it (a project's own threads included). */
export interface HiddenContainer {
  /** Its container key, which is also its level. */
  readonly key: LevelKey;
  readonly label: string;
  readonly place: RowPlace;
  readonly contents: ContainerContents;
  /** Real threads to render: a project's own plus those moved in. */
  readonly threads: readonly EnvironmentThreadShell[];
  /** The project real threads belong to, for their rows. */
  readonly projectName: string | null;
}

export interface BreakthroughGroup {
  readonly key: string;
  readonly label: string;
  readonly place: RowPlace;
  /** Only the items breaking through. */
  readonly contents: ContainerContents;
  readonly projectName: string | null;
  readonly rollup: StatusRollup;
}

/** The items in hidden folders that an escalation rule lets through, per folder. */
export function breakthroughGroups(input: {
  containers: readonly HiddenContainer[];
  focused: LevelKey;
  lastVisited: Readonly<Record<string, string>>;
  /** Mapped items break through only at their home, so a reference doesn't double them. */
  homeById: ReadonlyMap<string, string | null>;
}): BreakthroughGroup[] {
  const groups: BreakthroughGroup[] = [];
  for (const container of input.containers) {
    const passes = (status: ThreadDisplayStatus | null | undefined) =>
      status != null && breaksThroughFocus({ levels: [container.key], status }, input.focused);
    const { contents } = container;
    const through: ContainerContents = {
      loose: contents.loose.filter((item) => passes(item.status)),
      teamThreads: contents.teamThreads.filter((thread) =>
        passes(signalsForTeamThread(thread.id).status),
      ),
      rooms: contents.rooms.filter((room) => roomNeedsYou(room) && passes("input")),
      threads: container.threads.filter((thread) =>
        passes(statusForThread(thread, input.lastVisited[homeThreadKey(thread)])),
      ),
      mapped: contents.mapped.filter(
        (item) => input.homeById.get(item.id) === container.key && passes(item.status),
      ),
    };
    const rollup = rollupForContents(through, input.lastVisited);
    if (Object.values(through).every((list) => list.length === 0)) continue;
    groups.push({
      key: container.key,
      label: container.label,
      place: container.place,
      contents: through,
      projectName: container.projectName,
      rollup,
    });
  }
  return groups;
}
