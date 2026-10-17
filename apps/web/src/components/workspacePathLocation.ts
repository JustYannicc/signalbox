/** signalbox: see `workspacePathLocation.logic.ts`. */
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentSupports } from "../state/environmentCapabilities";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentCopy } from "../state/oneEnvironmentCopy";
import { resolveWorkspacePathLocation } from "./workspacePathLocation.logic";

/**
 * Where `environmentId`'s workspace paths live, read when a menu opens. Pass the
 * label the surface already shows for the environment; the server's own label
 * is the fallback.
 */
export function readWorkspacePathLocation(
  environmentId: EnvironmentId,
  environmentLabel?: string | null,
): string | null {
  const location = resolveWorkspacePathLocation({
    localFilesystem: readEnvironmentSupports(environmentId, "localFilesystem"),
    environmentLabel:
      environmentLabel ??
      appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.label,
  });
  // "Path on Signalbox", not "Path on Signalbox Cloud", where there's one environment.
  return location === null ? null : environmentCopy(location);
}
