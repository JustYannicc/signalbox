/**
 * Builds the Home tree: top-level items, then sections › (team) projects ›
 * items, as you arranged them (moves, renames, archive), with a calm rollup of
 * what needs you per node. Also derives the shortcut order (rendered rows
 * only), Move-to destinations, and Focus: hidden root sections drop out unless
 * the user is peeking, and their running work is summed for the chip.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useMemo } from "react";

import { TEAM_PROJECTS } from "../../multiplayer/multiplayerFixtures";
import type { TeamProject } from "../../multiplayer/multiplayerModel";
import { useRoomArchiveStore } from "../../rooms/rooms";
import { useUiStateStore } from "../../../uiStateStore";
import { focusModeInfo, useFocusStore } from "../focus/focusStore";
import { homeThreadKey, type HomeProjectEntry } from "../useHomeSidebarData";
import {
  buildContainerIndex,
  contentsOf,
  rollupForContents,
  teamProjectsFor,
  type ContainerContents,
} from "./containerContents";
import { mergeRollups, rollupOf, statusForThread, type StatusRollup } from "./homeStatus";
import {
  HOME_SECTIONS,
  allHomeSections,
  allLooseItems,
  assignProjectAgentIds,
  childSectionsOf,
  defaultSectionIdForProject,
  findHomeSection,
  rootSectionIdOf,
  sectionPathLabel,
  type HomeSection,
} from "./sectionModel";
import { ROOT_CONTAINER_KEY, useHomeSectionStore } from "./sectionStore";

export const PROJECT_THREAD_PREVIEW_COUNT = 5;

export interface HomeProjectView {
  readonly entry: HomeProjectEntry;
  readonly agentId: string;
  /** Its own threads minus those moved away, plus real threads moved in. */
  readonly threads: readonly EnvironmentThreadShell[];
  /** Fixture items moved into the project. */
  readonly contents: ContainerContents;
  readonly rollup: StatusRollup;
}

export interface HomeTeamProjectView {
  readonly project: TeamProject;
  readonly agentId: string;
  readonly contents: ContainerContents;
  readonly rollup: StatusRollup;
}

export interface HomeSectionNode {
  readonly section: HomeSection;
  readonly childSections: readonly HomeSectionNode[];
  readonly projects: readonly HomeProjectView[];
  readonly teamProjects: readonly HomeTeamProjectView[];
  /** Items that sit directly in the section. */
  readonly contents: ContainerContents;
  /** What needs you anywhere below this node. */
  readonly rollup: StatusRollup;
  /** Shown only because the user is peeking past Focus. */
  readonly peeked: boolean;
}

export interface MoveDestination {
  readonly key: string;
  readonly label: string;
  readonly kind: "root" | "section" | "project";
}

export interface FocusPausedSummary {
  readonly hiddenLabel: string;
  readonly runningCount: number;
}

export function isThreadRunning(thread: EnvironmentThreadShell): boolean {
  return thread.session?.status === "running" || thread.session?.status === "starting";
}

const byRecency = (left: EnvironmentThreadShell, right: EnvironmentThreadShell) =>
  Date.parse(right.latestUserMessageAt ?? right.updatedAt) -
  Date.parse(left.latestUserMessageAt ?? left.updatedAt);

export function useHomeSectionTree(input: {
  projectEntries: readonly HomeProjectEntry[];
  activeThreadKey: string | null;
}) {
  const { projectEntries, activeThreadKey } = input;
  const archivedRooms = useRoomArchiveStore((state) => state.archived);
  const lastVisited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const mode = useFocusStore((state) => state.mode);
  const peeking = useFocusStore((state) => state.peeking);
  const archived = useHomeSectionStore((state) => state.archived);
  // Cached by `allLooseItems`, so this only changes when loose items do.
  const looseItems = useHomeSectionStore(() => allLooseItems());
  const collapsedNodeKeys = useHomeSectionStore((state) => state.collapsedNodeKeys);
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const overrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  const showAllKeys = useHomeSectionStore((state) => state.showAllKeys);
  // Cached by `allHomeSections`, so this only changes when sections do.
  const sections = useHomeSectionStore(() => allHomeSections());
  const names = useHomeSectionStore((state) => state.names);

  return useMemo(() => {
    const hiddenRootIds = new Set(focusModeInfo(mode).hiddenRootSectionIds);
    const index = buildContainerIndex({
      projectEntries,
      looseItems,
      archived,
      archivedRooms,
      itemContainers,
    });
    const agentIds = assignProjectAgentIds([
      ...teamProjectKeys(),
      ...projectEntries.map((entry) => ({
        key: entry.group.projectKey,
        name: names[`project:${entry.group.projectKey}`] ?? entry.group.displayName,
      })),
    ]);

    const sectionIdByProjectKey = new Map<string, string>();
    const projectsBySection = new Map<string, HomeProjectView[]>();
    for (const entry of projectEntries) {
      const key = entry.group.projectKey;
      const override = overrides[key];
      const sectionId =
        override && findHomeSection(override) ? override : defaultSectionIdForProject(entry.group);
      sectionIdByProjectKey.set(key, sectionId);
      if (`project:${key}` in archived) continue;
      const contents = contentsOf(index, `project:${key}`);
      const threads = [
        ...entry.threads.filter((thread) => !index.movedThreadKeys.has(homeThreadKey(thread))),
        ...contents.threads,
      ].toSorted(byRecency);
      const fixtures = { ...contents, threads: [] };
      const withFixtures: HomeProjectView = {
        entry,
        agentId: agentIds.get(key) ?? `project-${key}`,
        threads,
        contents: fixtures,
        rollup: mergeRollups([
          rollupOf(
            threads.map((thread) => ({
              status: statusForThread(thread, lastVisited[homeThreadKey(thread)]),
            })),
          ),
          rollupForContents(fixtures, lastVisited),
        ]),
      };
      const bucket = projectsBySection.get(sectionId);
      if (bucket) bucket.push(withFixtures);
      else projectsBySection.set(sectionId, [withFixtures]);
    }

    const isHiddenSection = (sectionId: string) => hiddenRootIds.has(rootSectionIdOf(sectionId));

    const buildNode = (section: HomeSection): HomeSectionNode => {
      const childSections = childSectionsOf(section.id)
        .filter((child) => !(`section:${child.id}` in archived))
        .map(buildNode);
      const projects = projectsBySection.get(section.id) ?? [];
      const teamProjects = teamProjectsFor(section.id, overrides, archived).map((project) => {
        const contents = contentsOf(index, `team-project:${project.id}`);
        return {
          project,
          agentId: agentIds.get(`team-project:${project.id}`) ?? `project-${project.id}`,
          contents,
          rollup: rollupForContents(contents, lastVisited),
        };
      });
      const contents = contentsOf(index, `section:${section.id}`);
      const rollup = mergeRollups([
        ...childSections.map((child) => child.rollup),
        // A child section's agent counts toward its parent's summary.
        rollupOf(childSections.map((child) => ({ status: child.section.agentStatus }))),
        ...projects.map((project) => project.rollup),
        ...teamProjects.map((project) => project.rollup),
        rollupForContents(contents, lastVisited),
      ]);
      return {
        section,
        childSections,
        projects,
        teamProjects,
        contents,
        rollup,
        peeked: isHiddenSection(section.id),
      };
    };
    const roots = childSectionsOf(null)
      .filter((section) => peeking || !hiddenRootIds.has(section.id))
      .filter((section) => !(`section:${section.id}` in archived))
      .map(buildNode);
    const rootContents = contentsOf(index, ROOT_CONTAINER_KEY);

    // Keyboard shortcuts walk the real threads that are actually on screen.
    const isOpen = (nodeKey: string) => collapsedNodeKeys[nodeKey] !== true;
    const orderedThreads: EnvironmentThreadShell[] = [...rootContents.threads];
    const collect = (node: HomeSectionNode) => {
      if (!isOpen(`section:${node.section.id}`)) return;
      node.childSections.forEach(collect);
      for (const project of node.projects) {
        const key = project.entry.group.projectKey;
        if (!isOpen(`project:${key}`)) continue;
        const activeIndex = project.threads.findIndex(
          (thread) => homeThreadKey(thread) === activeThreadKey,
        );
        const showAll = key in showAllKeys || activeIndex >= PROJECT_THREAD_PREVIEW_COUNT;
        orderedThreads.push(
          ...(showAll ? project.threads : project.threads.slice(0, PROJECT_THREAD_PREVIEW_COUNT)),
        );
      }
      orderedThreads.push(...node.contents.threads);
    };
    roots.forEach(collect);

    const destinations: MoveDestination[] = [
      { key: ROOT_CONTAINER_KEY, label: "Top level", kind: "root" },
      ...sections.map((section) => ({
        key: `section:${section.id}`,
        label: sectionPathLabel(section.id),
        kind: "section" as const,
      })),
      ...[...projectsBySection.entries()].flatMap(([sectionId, projects]) =>
        projects.map((project) => ({
          key: `project:${project.entry.group.projectKey}`,
          label: `${sectionPathLabel(sectionId)} › ${
            names[`project:${project.entry.group.projectKey}`] ?? project.entry.group.displayName
          }`,
          kind: "project" as const,
        })),
      ),
      ...sections.flatMap((section) =>
        teamProjectsFor(section.id, overrides, archived).map((project) => ({
          key: `team-project:${project.id}`,
          label: `${sectionPathLabel(section.id)} › ${
            names[`team-project:${project.id}`] ?? project.name
          }`,
          kind: "project" as const,
        })),
      ),
    ];

    let paused: FocusPausedSummary | null = null;
    if (hiddenRootIds.size > 0) {
      const hiddenSections = [...hiddenRootIds].flatMap((id) => findHomeSection(id) ?? []);
      const hiddenThreads = projectEntries
        .filter((entry) => {
          const sectionId = sectionIdByProjectKey.get(entry.group.projectKey);
          return sectionId !== undefined && isHiddenSection(sectionId);
        })
        .flatMap((entry) => entry.threads);
      const busyAgents = HOME_SECTIONS.filter(
        (section) => section.agentStatus === "working" && isHiddenSection(section.id),
      ).length;
      paused = {
        hiddenLabel: hiddenSections.map((section) => section.name).join(" & "),
        runningCount: hiddenThreads.filter(isThreadRunning).length + busyAgents,
      };
    }

    return { roots, rootContents, orderedThreads, destinations, paused, peeking, index };
  }, [
    activeThreadKey,
    archived,
    archivedRooms,
    collapsedNodeKeys,
    itemContainers,
    lastVisited,
    looseItems,
    mode,
    names,
    overrides,
    peeking,
    projectEntries,
    sections,
    showAllKeys,
  ]);
}

/** Team projects claim their readable agent ids first (they match the agent fixtures). */
function teamProjectKeys() {
  return TEAM_PROJECTS.map((project) => ({ key: `team-project:${project.id}`, name: project.id }));
}

export type HomeSectionTree = ReturnType<typeof useHomeSectionTree>;
