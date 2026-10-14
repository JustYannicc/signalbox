// signalbox: the pool each project runs on, as its server resolved it, on the web client.
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { projectPool, projectPoolModelSelection } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { ResolvedPool, SectionsSnapshot } from "@t3tools/contracts/sections";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentSections } from "./sections";

const sectionSnapshotsAtom = Atom.make((get) => {
  const snapshots = new Map<EnvironmentId, SectionsSnapshot | null>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    snapshots.set(environmentId, get(environmentSections.snapshotAtom(environmentId)));
  }
  return snapshots;
}).pipe(Atom.withLabel("web-section-pool-snapshots"));

/**
 * Moves a new thread's model onto the pool its project runs on. Subscribes to
 * the section trees, which carry the pools, so they are current when a thread
 * starts from anywhere.
 */
export function useProjectPoolModelSelection() {
  const snapshots = useAtomValue(sectionSnapshotsAtom);
  return useCallback(
    (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
      /** What the thread would otherwise start on. */
      readonly selection: ModelSelection | null;
      readonly providerInstances: Readonly<Record<string, { readonly config?: unknown }>>;
      readonly providers: ReadonlyArray<ServerProvider>;
    }): ModelSelection | null =>
      projectPoolModelSelection({
        ...input,
        snapshot: snapshots.get(input.environmentId) ?? null,
      }),
    [snapshots],
  );
}

/** The pool `projectId`'s threads run on: null for none, undefined where the server doesn't say. */
export function useProjectPool(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ResolvedPool | null | undefined {
  const snapshots = useAtomValue(sectionSnapshotsAtom);
  return environmentId === null
    ? undefined
    : projectPool(snapshots.get(environmentId) ?? null, projectId);
}

/** The model a composer draft holds for its active provider, after sticky state. */
export function draftModelSelection(
  draft: {
    readonly activeProvider?: string | null;
    readonly modelSelectionByProvider: Readonly<Record<string, ModelSelection | undefined>>;
  } | null,
): ModelSelection | null {
  const provider = draft?.activeProvider;
  return provider ? (draft.modelSelectionByProvider[provider] ?? null) : null;
}
