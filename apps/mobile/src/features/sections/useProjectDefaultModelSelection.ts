// signalbox: section pool defaults for new tasks on mobile.
import { useAtomValue } from "@effect/atom-react";
import { projectDefaultModelSelectionWithSectionPool } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentSections } from "../../state/sections";

const NO_SNAPSHOT = Atom.make<SectionsSnapshot | null>(null);

/**
 * The model a new task in the project starts on: the project's own default,
 * else the environment default on the pool of the project's nearest section.
 */
export function useProjectDefaultModelSelection(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly resolved: Pick<ResolvedProjectSettings, "settings" | "sources">;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const snapshot = useAtomValue(
    input.environmentId ? environmentSections.snapshotAtom(input.environmentId) : NO_SNAPSHOT,
  );
  const { projectId, resolved, providers } = input;
  return useMemo(
    () => projectDefaultModelSelectionWithSectionPool({ resolved, snapshot, projectId, providers }),
    [projectId, providers, resolved, snapshot],
  );
}
