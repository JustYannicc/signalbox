/**
 * Signalbox Cloud contexts, per cloud environment. Sections organize them
 * through `state/sections.ts` like on any server; this says which context
 * each project belongs to.
 */
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createSignalboxContextsAtoms } from "@t3tools/client-runtime/state/signalboxContexts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const signalboxContexts = createSignalboxContextsAtoms(connectionAtomRuntime);

/** Each connected Signalbox Cloud environment's contexts, once they've arrived. */
export const environmentContextsAtom = Atom.make((get) => {
  const contexts = new Map<EnvironmentId, SignalboxContextsSnapshot>();
  const configs = get(environmentServerConfigsAtom);
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (configs.get(environmentId)?.environment.capabilities.signalboxCloud !== true) continue;
    const snapshot = AsyncResult.value(
      get(signalboxContexts.snapshot({ environmentId, input: {} })),
    );
    if (Option.isSome(snapshot)) contexts.set(environmentId, snapshot.value);
  }
  return contexts;
}).pipe(Atom.withLabel("web-environment-contexts"));
