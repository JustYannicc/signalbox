// signalbox: section pool defaults for new threads on the web client.
import { projectDefaultModelSelectionWithSectionPool } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSections } from "./sections";

/**
 * The model a new thread in the project starts on: the project's own default,
 * else the environment default on the pool of the project's nearest section.
 */
export function readProjectDefaultModelSelection(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly resolved: Pick<ResolvedProjectSettings, "settings" | "sources">;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  return projectDefaultModelSelectionWithSectionPool({
    ...input,
    snapshot: appAtomRegistry.get(environmentSections.snapshotAtom(input.environmentId)),
  });
}
