/** Signalbox Cloud drives, scoped to each connected cloud environment. */
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createSignalboxDrivesAtoms } from "@t3tools/client-runtime/state/signalboxDrives";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxDrivesSnapshot } from "@t3tools/contracts/signalboxDrives";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const signalboxDrives = createSignalboxDrivesAtoms(connectionAtomRuntime);

/** Each connected Signalbox Cloud environment's drives, once they've arrived. */
export const environmentDrivesAtom = Atom.make((get) => {
  const drives = new Map<EnvironmentId, SignalboxDrivesSnapshot>();
  const configs = get(environmentServerConfigsAtom);
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (configs.get(environmentId)?.environment.capabilities.signalboxCloud !== true) continue;
    const snapshot = AsyncResult.value(get(signalboxDrives.snapshot({ environmentId, input: {} })));
    if (Option.isSome(snapshot)) drives.set(environmentId, snapshot.value);
  }
  return drives;
}).pipe(Atom.withLabel("web-environment-drives"));
