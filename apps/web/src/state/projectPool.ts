// signalbox: the pool each thread runs on, as its server resolved it, on the web client.
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  poolModelSelection,
  projectPool,
  type PlacedPool,
} from "@t3tools/client-runtime/state/sections";
import { poolOfTarget } from "@t3tools/client-runtime/state/signalboxFolders";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { PoolLevel, SectionsSnapshot } from "@t3tools/contracts/sections";
import type { FolderLevel, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentSections } from "./sections";
import { environmentFoldersAtom } from "./signalboxFolders";

/**
 * Where an environment's pools come from: its folders where it serves them
 * (`folders` is null until they arrive), else its sections.
 */
type PoolSource =
  | { readonly _tag: "folders"; readonly folders: SignalboxFoldersSnapshot | null }
  | { readonly _tag: "sections"; readonly sections: SectionsSnapshot | null };

const poolSourcesAtom = Atom.make((get) => {
  const sources = new Map<EnvironmentId, PoolSource>();
  const folders = get(environmentFoldersAtom);
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const environmentFolders = folders.get(environmentId);
    sources.set(
      environmentId,
      environmentFolders
        ? { _tag: "folders", folders: environmentFolders.snapshot }
        : { _tag: "sections", sections: get(environmentSections.snapshotAtom(environmentId)) },
    );
  }
  return sources;
}).pipe(Atom.withLabel("web-pool-sources"));

/** Which thread, or which project a new thread starts in. */
interface PoolTarget {
  readonly projectId: ProjectId | null;
  /** The thread or draft: where folders do, its filing decides its home. */
  readonly threadId?: ThreadId | null | undefined;
}

/** A pool and the level it's placed at, as the server says. */
export type ResolvedPlacedPool = PlacedPool & { readonly from: PoolLevel | FolderLevel };

/**
 * The pool `target` runs on: its home's where folders do, else its project's.
 * Null for none on its chain; undefined while unknown or where the server
 * doesn't resolve pools.
 */
function resolvePool(
  source: PoolSource | undefined,
  target: PoolTarget,
): ResolvedPlacedPool | null | undefined {
  if (source === undefined) return undefined;
  if (source._tag === "sections") return projectPool(source.sections, target.projectId);
  return source.folders === null ? undefined : poolOfTarget(source.folders, target);
}

/**
 * Moves a new thread's model onto the pool it runs on. Subscribes to the
 * trees, which carry the pools, so they are current when a thread starts
 * from anywhere.
 */
export function useProjectPoolModelSelection() {
  const sources = useAtomValue(poolSourcesAtom);
  return useCallback(
    (
      input: PoolTarget & {
        readonly environmentId: EnvironmentId;
        /** What the thread would otherwise start on. */
        readonly selection: ModelSelection | null;
        readonly providerInstances: Readonly<Record<string, { readonly config?: unknown }>>;
        readonly providers: ReadonlyArray<ServerProvider>;
      },
    ): ModelSelection | null =>
      poolModelSelection({
        ...input,
        pool: resolvePool(sources.get(input.environmentId), input),
      }),
    [sources],
  );
}

/** The pool a thread (or a new thread in `projectId`) runs on; see `resolvePool`. */
export function useProjectPool(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  threadId?: ThreadId | null,
): ResolvedPlacedPool | null | undefined {
  const sources = useAtomValue(poolSourcesAtom);
  return environmentId === null
    ? undefined
    : resolvePool(sources.get(environmentId), { projectId, threadId });
}

/** The model a composer draft holds for its active provider, after sticky state. */
export function draftModelSelection(
  draft: {
    readonly activeProvider?: string | null;
    readonly modelSelectionByProvider: Readonly<Record<string, ModelSelection | undefined>>;
  } | null,
): ModelSelection | null {
  const provider = draft?.activeProvider;
  return provider ? (draft.modelSelectionByProvider[provider] ?? null) : null;
}
