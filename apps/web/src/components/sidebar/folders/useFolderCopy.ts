/**
 * signalbox: `folderCopy.ts` for the environment a surface is showing. Upstream
 * files reach these through one hook line each.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { serverEnvironment } from "../../../state/server";
import { draftHeroCopy, projectSettingsLabel, type DraftHeroCopy } from "./folderCopy";

/** The new-thread hero's words on `environmentId`. */
export function useDraftHeroCopy(environmentId: EnvironmentId | null): DraftHeroCopy {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return draftHeroCopy(environmentId !== null && config?.environment.capabilities.folders === true);
}

/** What opening a project's settings is called on `environmentId`, read when a menu opens. */
export function readProjectSettingsLabel(environmentId: EnvironmentId | null): string {
  if (environmentId === null) return projectSettingsLabel(false);
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  return projectSettingsLabel(config?.environment.capabilities.folders === true);
}
