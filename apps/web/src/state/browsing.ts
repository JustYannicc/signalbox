/** A thread's synced browser tabs (#585): the record in Signalbox Cloud every device loads. */
import { createBrowsingAtoms } from "@t3tools/client-runtime/state/browsing";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { environmentServerConfigsAtom } from "./server";

export const browsing = createBrowsingAtoms(connectionAtomRuntime);

/** Whether the environment keeps threads' tabs in a synced record. Self-hosted servers don't. */
export function useEnvironmentSupportsThreadBrowsing(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.threadBrowsing === true
  );
}

export function readEnvironmentSupportsThreadBrowsing(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadBrowsing === true
  );
}
