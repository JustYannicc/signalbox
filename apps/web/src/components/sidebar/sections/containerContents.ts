/**
 * Where every Home item sits. Tasks, chats, and rooms can live in any
 * container (top level, section, project, team project); each has a natural
 * home and moves via `itemContainers`. Real threads moved out of their project
 * travel too. Automations, accounts and mapped places come from `mappedItems`:
 * each has one home, and places and accounts also show where they're referenced. Also the rollup inputs, so folders can summarize
 * what needs you, and the calm count of what sits below them.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { TEAM_PROJECTS, TEAM_THREADS } from "../../multiplayer/multiplayerFixtures";
import type { TeamProject, TeamThread } from "../../multiplayer/multiplayerModel";
import { currentPerson } from "../../multiplayer/teamThreads";
import type { Room } from "../../rooms/roomModel";
import { ALL_ROOMS } from "../../rooms/rooms";
import { homeThreadKey, type HomeProjectEntry } from "../useHomeSidebarData";
import type { ThreadDisplayStatus } from "../../threadStatusDisplay";
import { rollupOf, statusForThread, type RollupInput, type StatusRollup } from "./homeStatus";
import { signalsForTeamThread } from "./itemSignals";
import type { MappedIndex, MappedItem } from "./mappedItems";
import type { LooseItem } from "./sectionModel";
import { ROOT_CONTAINER_KEY } from "./sectionStore";

export interface ContainerContents {
  readonly loose: readonly LooseItem[];
  readonly teamThreads: readonly TeamThread[];
  readonly rooms: readonly Room[];
  /** Real threads moved here from their project. */
  readonly threads: readonly EnvironmentThreadShell[];
  /** Automations, accounts and mapped places, needs-you first. */
  readonly mapped: readonly MappedItem[];
}

const EMPTY: ContainerContents = { loose: [], teamThreads: [], rooms: [], threads: [], mapped: [] };

type Mutable = { -readonly [K in keyof ContainerContents]: ContainerContents[K][number][] };

export interface ContainerIndex {
  readonly byContainer: ReadonlyMap<string, ContainerContents>;
  /** Real thread keys that left their project. */
  readonly movedThreadKeys: ReadonlySet<string>;
}

export function looseNaturalKey(item: LooseItem): string {
  return item.sectionId ? `section:${item.sectionId}` : ROOT_CONTAINER_KEY;
}

export function buildContainerIndex(input: {
  projectEntries: readonly HomeProjectEntry[];
  /** `allLooseItems()`, passed in so callers can subscribe to it. */
  looseItems: readonly LooseItem[];
  archived: Readonly<Record<string, unknown>>;
  archivedRooms: Readonly<Record<string, unknown>>;
  itemContainers: Readonly<Record<string, string>>;
  mapped: MappedIndex;
}): ContainerIndex {
  const { archived, itemContainers } = input;
  const byContainer = new Map<string, Mutable>();
  const bucket = (key: string) => {
    let entry = byContainer.get(key);
    if (!entry) {
      entry = { loose: [], teamThreads: [], rooms: [], threads: [], mapped: [] };
      byContainer.set(key, entry);
    }
    return entry;
  };
  for (const item of input.looseItems) {
    if (item.id in archived) continue;
    bucket(itemContainers[item.id] ?? looseNaturalKey(item)).loose.push(item);
  }
  for (const thread of TEAM_THREADS) {
    if (thread.id in archived) continue;
    bucket(itemContainers[thread.id] ?? `team-project:${thread.projectId}`).teamThreads.push(
      thread,
    );
  }
  for (const room of ALL_ROOMS) {
    if (room.id in input.archivedRooms) continue;
    bucket(itemContainers[room.id] ?? room.containerKey).rooms.push(room);
  }
  for (const [key, items] of input.mapped.byContainer) bucket(key).mapped.push(...items);
  const movedThreadKeys = new Set<string>();
  for (const entry of input.projectEntries) {
    const natural = `project:${entry.group.projectKey}`;
    for (const thread of entry.threads) {
      const key = homeThreadKey(thread);
      const target = itemContainers[key];
      if (target === undefined || target === natural) continue;
      movedThreadKeys.add(key);
      bucket(target).threads.push(thread);
    }
  }
  return { byContainer, movedThreadKeys };
}

export function contentsOf(index: ContainerIndex, containerKey: string): ContainerContents {
  return index.byContainer.get(containerKey) ?? EMPTY;
}

export function isContentsEmpty(contents: ContainerContents): boolean {
  return (
    contents.loose.length === 0 &&
    contents.teamThreads.length === 0 &&
    contents.rooms.length === 0 &&
    contents.threads.length === 0 &&
    contents.mapped.length === 0
  );
}

export function teamProjectsFor(
  sectionId: string,
  overrides: Readonly<Record<string, string>>,
  archived: Readonly<Record<string, unknown>>,
): readonly TeamProject[] {
  return TEAM_PROJECTS.filter((project) => {
    const key = `team-project:${project.id}`;
    return !(key in archived) && (overrides[key] ?? project.sectionId) === sectionId;
  });
}

export function roomNeedsYou(room: Room): boolean {
  return room.status === "open" && room.waitingOnId === currentPerson.id;
}

export function teamThreadWaitingOn(thread: TeamThread): string | null {
  const waitingOn = signalsForTeamThread(thread.id).waitingOnId;
  return waitingOn && waitingOn !== currentPerson.id ? waitingOn : null;
}

function teamThreadInput(thread: TeamThread): RollupInput {
  const signals = signalsForTeamThread(thread.id);
  return { status: signals.status ?? null, mentioned: signals.mentionedById !== undefined };
}

export function rollupForContents(
  contents: ContainerContents,
  lastVisitedAtByKey: Readonly<Record<string, string>>,
): StatusRollup {
  return rollupOf([
    ...contents.loose.map((item) => ({ status: item.status ?? null })),
    ...contents.teamThreads.map(teamThreadInput),
    ...contents.rooms.map((room) => ({ status: roomNeedsYou(room) ? ("input" as const) : null })),
    ...contents.threads.map((thread) => ({
      status: statusForThread(thread, lastVisitedAtByKey[homeThreadKey(thread)]),
    })),
    ...contents.mapped.map((item) => ({ status: item.status })),
  ]);
}

/**
 * What a folder holds, counted down the tree ("go into that scope, that's
 * everything below"). Calm: folder rows only show it on hover.
 */
export interface SubtreeSummary {
  /** Chats, tasks, rooms and real threads. */
  readonly threads: number;
  readonly automations: number;
  /** Places and the accounts they sit in. */
  readonly places: number;
  /** Threads and automations working right now. */
  readonly working: number;
}

export const EMPTY_SUMMARY: SubtreeSummary = { threads: 0, automations: 0, places: 0, working: 0 };

const isWorking = (status: ThreadDisplayStatus | null | undefined) =>
  status === "working" || status === "goal";

/**
 * One container's own things. Mapped items count only at their home, so a
 * reference elsewhere in the same subtree isn't counted twice. Pass a
 * project's own threads as `threads` (its contents carry only moved-in ones).
 */
export function summarizeContents(
  contents: ContainerContents,
  containerKey: string,
  homeById: ReadonlyMap<string, string | null>,
  lastVisitedAtByKey: Readonly<Record<string, string>>,
  threads: readonly EnvironmentThreadShell[] = contents.threads,
): SubtreeSummary {
  const statuses = [
    ...contents.loose.map((item) => item.status),
    ...contents.teamThreads.map((thread) => signalsForTeamThread(thread.id).status),
    ...threads.map((thread) => statusForThread(thread, lastVisitedAtByKey[homeThreadKey(thread)])),
  ];
  const homed = contents.mapped.filter((item) => homeById.get(item.id) === containerKey);
  const automations = homed.filter((item) => item.kind === "automation");
  return {
    threads:
      contents.loose.length + contents.teamThreads.length + contents.rooms.length + threads.length,
    automations: automations.length,
    places: homed.filter((item) => item.kind === "place" || item.kind === "account").length,
    working:
      statuses.filter(isWorking).length +
      automations.filter((item) => isWorking(item.status)).length,
  };
}

export function mergeSummaries(summaries: Iterable<SubtreeSummary>): SubtreeSummary {
  let threads = 0;
  let automations = 0;
  let places = 0;
  let working = 0;
  for (const summary of summaries) {
    threads += summary.threads;
    automations += summary.automations;
    places += summary.places;
    working += summary.working;
  }
  return { threads, automations, places, working };
}

const plural = (count: number, one: string, many: string) =>
  count > 0 ? `${count} ${count === 1 ? one : many}` : null;

/** "14 threads · 3 automations · 5 places · 2 working", or null when the folder is empty. */
export function describeSummary(summary: SubtreeSummary): string | null {
  const parts = [
    plural(summary.threads, "thread", "threads"),
    plural(summary.automations, "automation", "automations"),
    plural(summary.places, "place", "places"),
    summary.working > 0 ? `${summary.working} working` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
