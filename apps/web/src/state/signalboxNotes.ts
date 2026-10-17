/**
 * Signalbox Cloud notes, per environment that serves them
 * (`capabilities.notes`). A pad subscribes to its environment's notes only
 * while it's open.
 */
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createSignalboxNotesAtoms } from "@t3tools/client-runtime/state/signalboxNotes";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const signalboxNotes = createSignalboxNotesAtoms(connectionAtomRuntime);

/**
 * The connected environments that keep notes. Server config events that
 * change none of them answer the same set.
 */
export const notesEnvironmentsAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(get.self<ReadonlySet<EnvironmentId>>());
  const configs = get(environmentServerConfigsAtom);
  const environments = new Set<EnvironmentId>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (configs.get(environmentId)?.environment.capabilities.notes === true) {
      environments.add(environmentId);
    }
  }
  const unchanged =
    previous !== undefined &&
    previous.size === environments.size &&
    [...environments].every((environmentId) => previous.has(environmentId));
  return unchanged ? previous : environments;
}).pipe(Atom.withLabel("web-environment-notes"));
