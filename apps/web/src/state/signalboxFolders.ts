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

/**
 * Every connected environment that serves folders, keyed by id, whether or
 * not they've arrived. Server config events that change none of them answer
 * the same map, and an unchanged environment keeps its entry.
 */
export const environmentFoldersAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<EnvironmentId, EnvironmentFolders>>(),
  );
  const folders = new Map<EnvironmentId, EnvironmentFolders>();
  const configs = get(environmentServerConfigsAtom);
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (configs.get(environmentId)?.environment.capabilities.folders !== true) continue;
    const result = get(signalboxFolders.snapshot({ environmentId, input: {} }));
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    const error =
      result._tag === "Failure" && snapshot === null
        ? formatEnvironmentQueryError(result.cause)
        : null;
    const kept = previous?.get(environmentId);
    folders.set(
      environmentId,
      kept?.snapshot === snapshot && kept.error === error ? kept : { snapshot, error },
    );
  }
  const unchanged =
    previous !== undefined &&
    previous.size === folders.size &&
    [...folders].every(([environmentId, entry]) => previous.get(environmentId) === entry);
  return unchanged ? previous : folders;
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

export const folderStartableEnvironmentsAtom = Atom.make((get) => {
  const startable = new Set<EnvironmentId>();
  for (const environmentId of get(environmentFoldersAtom).keys()) {
    if (get(signalboxFolders.startFrom.permissionAtom(environmentId))) startable.add(environmentId);
  }
  return startable;
}).pipe(Atom.withLabel("web-environment-folders:startable"));
