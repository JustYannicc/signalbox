// signalbox: section pool defaults for new threads on the web client.
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { sectionPoolModelSelection } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
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
 * Picks a new thread's model on its project's section pool. Subscribes to the
 * section trees, so they are current when a thread starts from anywhere.
 */
export function useSectionPoolModelSelection() {
  const snapshots = useAtomValue(sectionSnapshotsAtom);
  return useCallback(
    (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
      /** What the thread would otherwise start on. */
      readonly selection: ModelSelection | null;
      readonly resolved: Pick<ResolvedProjectSettings, "settings" | "sources">;
      readonly providers: ReadonlyArray<ServerProvider>;
    }): ModelSelection | null =>
      sectionPoolModelSelection({ ...input, snapshot: snapshots.get(input.environmentId) ?? null }),
    [snapshots],
  );
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
