/**
 * Signalbox Cloud folders, per environment that serves them
 * (`capabilities.folders`). Those environments show their folders instead of
 * sections; every other environment keeps `state/sections.ts`.
 */
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createSignalboxFoldersAtoms } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { formatEnvironmentQueryError } from "./query";
import { environmentServerConfigsAtom } from "./server";

export const signalboxFolders = createSignalboxFoldersAtoms(connectionAtomRuntime);

/** One environment's folders: null until they arrive, with why when they couldn't. */
export interface EnvironmentFolders {
  readonly snapshot: SignalboxFoldersSnapshot | null;
  readonly error: string | null;
}

/** Every connected environment that serves folders, keyed by id, whether or not they've arrived. */
export const environmentFoldersAtom = Atom.make((get) => {
  const folders = new Map<EnvironmentId, EnvironmentFolders>();
  const configs = get(environmentServerConfigsAtom);
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (configs.get(environmentId)?.environment.capabilities.folders !== true) continue;
    const result = get(signalboxFolders.snapshot({ environmentId, input: {} }));
    const snapshot = AsyncResult.value(result);
    folders.set(environmentId, {
      snapshot: Option.getOrNull(snapshot),
      error:
        result._tag === "Failure" && Option.isNone(snapshot)
          ? formatEnvironmentQueryError(result.cause)
          : null,
    });
  }
  return folders;
}).pipe(Atom.withLabel("web-environment-folders"));

/** Subscribes to an environment's folders again after they failed. */
export const retryEnvironmentFolders = Atom.fn((environmentId: EnvironmentId, get) =>
  Effect.sync(() => get.refresh(signalboxFolders.snapshot({ environmentId, input: {} }))),
).pipe(Atom.withLabel("web-environment-folders:retry"));

/** The folder environments where this connection may change folders and file threads. */
export const folderEditableEnvironmentsAtom = Atom.make((get) => {
  const editable = new Set<EnvironmentId>();
  for (const environmentId of get(environmentFoldersAtom).keys()) {
    if (get(signalboxFolders.updateFolder.permissionAtom(environmentId)))
      editable.add(environmentId);
  }
  return editable;
}).pipe(Atom.withLabel("web-environment-folders:editable"));
