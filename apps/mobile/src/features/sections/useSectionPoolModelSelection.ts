// signalbox: section pool defaults for new tasks on mobile.
import { useAtomValue } from "@effect/atom-react";
import { sectionPoolModelSelection } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentSections } from "../../state/sections";

const NO_SNAPSHOT = Atom.make<SectionsSnapshot | null>(null);

/**
 * `selection`, the model a new task would otherwise start on, moved onto the
 * pool of the project's nearest section. Null when no section pool applies.
 */
export function useSectionPoolModelSelection(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly selection: ModelSelection | null;
  readonly resolved: Pick<ResolvedProjectSettings, "settings" | "sources">;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const snapshot = useAtomValue(
    input.environmentId ? environmentSections.snapshotAtom(input.environmentId) : NO_SNAPSHOT,
  );
  const { projectId, selection, resolved, providers } = input;
  return useMemo(
    () => sectionPoolModelSelection({ selection, resolved, snapshot, projectId, providers }),
    [projectId, providers, resolved, selection, snapshot],
  );
}
