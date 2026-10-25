import type { ProjectId } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import {
  SIGNALBOX_CONTEXTS_WS_METHODS,
  type SignalboxContext,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import type { SectionDestination } from "./sectionsModel.ts";
import { sectionDestinations } from "./sectionsMoves.ts";

/**
 * A Signalbox Cloud user's contexts, for one environment. Only environments
 * advertising `capabilities.signalboxCloud` serve them. Sections organize each
 * context through the ordinary `sections.*` contract.
 */
export function createSignalboxContextsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-contexts:snapshot",
      tag: SIGNALBOX_CONTEXTS_WS_METHODS.subscribe,
    }),
  };
}

/** The context a project belongs to, if any. */
export function contextOfProject(
  snapshot: SignalboxContextsSnapshot | null,
  projectId: ProjectId,
): SignalboxContext | undefined {
  return snapshot?.contexts.find((context) => context.projectIds.includes(projectId));
}

/** The id of the context a project belongs to, if any. */
export function contextIdOfProject(
  snapshot: SignalboxContextsSnapshot | null,
  projectId: ProjectId,
): string | undefined {
  return contextOfProject(snapshot, projectId)?.id;
}

/**
 * The sections a project can move into: those of its own context. Outside the
 * cloud neither has a context, so that is every section.
 */
export function projectSectionDestinations(
  snapshot: SectionsSnapshot,
  contextId: string | undefined,
): ReadonlyArray<SectionDestination> {
  return sectionDestinations(snapshot).filter(
    (destination) => destination.section.contextId === contextId,
  );
}

/** A project's siblings for reordering: only its own context's projects in the cloud. */
export function projectsInContextOf<Project extends { readonly id: ProjectId }>(
  snapshot: SignalboxContextsSnapshot | null,
  projectId: ProjectId,
  projects: ReadonlyArray<Project>,
): ReadonlyArray<Project> {
  const context = snapshot?.contexts.find((candidate) => candidate.projectIds.includes(projectId));
  return context ? projects.filter((project) => context.projectIds.includes(project.id)) : projects;
}
