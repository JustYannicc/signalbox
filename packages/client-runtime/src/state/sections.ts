import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentId, ProjectId, ServerConfig } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand, followStreamInEnvironment } from "./runtime.ts";
import { applySectionsSnapshotForSession, sectionTreeFromSnapshot } from "./sectionsModel.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";

export * from "./sectionsModel.ts";
export * from "./sectionsMoves.ts";

export type EnvironmentSectionsState =
  | { readonly _tag: "Unsupported" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failure"; readonly error: string };

function formatSectionsError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not load sections.";
}

export function createEnvironmentSectionAtoms<R, E, Project extends { readonly id: ProjectId }>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  input: {
    readonly serverConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
    readonly projectsAtom: (environmentId: EnvironmentId) => Atom.Atom<ReadonlyArray<Project>>;
  },
) {
  const rawSnapshotAtom = Atom.family((environmentId: EnvironmentId) => {
    let activeSession: RpcSession | null = null;
    const streamState: { session: RpcSession | null; snapshot: SectionsSnapshot | null } = {
      session: null,
      snapshot: null,
    };
    const liveSnapshots = subscribeDynamicWithSession(WS_METHODS.sectionsSubscribe, (session) =>
      Effect.sync(() => {
        activeSession = session;
        return {};
      }),
    ).pipe(
      Stream.filterMap(([session, incoming]) => {
        const next = applySectionsSnapshotForSession(streamState, activeSession, session, incoming);
        if (next === streamState) return Result.failVoid;
        streamState.session = next.session;
        streamState.snapshot = next.snapshot;
        return Result.succeed(incoming);
      }),
    );
    const latestSnapshot = Stream.fromEffect(Effect.sync(() => streamState.snapshot)).pipe(
      Stream.filterMap((snapshot) =>
        snapshot === null ? Result.failVoid : Result.succeed(snapshot),
      ),
    );
    const stream = Stream.concat(latestSnapshot, liveSnapshots);
    return runtime
      .atom(followStreamInEnvironment(environmentId, stream), { initialValue: null })
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-sections-source:${environmentId}`));
  });

  const snapshotAtomFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): SectionsSnapshot | null => {
      if (
        get(input.serverConfigValueAtom(environmentId))?.environment.capabilities.sections !== true
      ) {
        return null;
      }
      return Option.getOrNull(AsyncResult.value(get(rawSnapshotAtom(environmentId))));
    }).pipe(Atom.withLabel(`environment-sections:${environmentId}`)),
  );

  const treeAtomFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      sectionTreeFromSnapshot(
        get(snapshotAtomFamily(environmentId)),
        get(input.projectsAtom(environmentId)),
      ),
    ).pipe(Atom.withLabel(`environment-section-tree:${environmentId}`)),
  );

  const stateAtomFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): EnvironmentSectionsState => {
      if (
        get(input.serverConfigValueAtom(environmentId))?.environment.capabilities.sections !== true
      ) {
        return { _tag: "Unsupported" };
      }
      const result = get(rawSnapshotAtom(environmentId));
      if (result._tag === "Failure") {
        return { _tag: "Failure", error: formatSectionsError(result.cause) };
      }
      if (Option.isSome(AsyncResult.value(result))) return { _tag: "Ready" };
      return { _tag: "Loading" };
    }).pipe(Atom.withLabel(`environment-sections-state:${environmentId}`)),
  );

  return {
    snapshotAtom: (environmentId: EnvironmentId) => snapshotAtomFamily(environmentId),
    treeAtom: (environmentId: EnvironmentId) => treeAtomFamily(environmentId),
    stateAtom: (environmentId: EnvironmentId) => stateAtomFamily(environmentId),
    createSection: createEnvironmentRpcCommand(runtime, {
      label: "environment-sections:create",
      tag: WS_METHODS.sectionsCreate,
    }),
    updateSection: createEnvironmentRpcCommand(runtime, {
      label: "environment-sections:update",
      tag: WS_METHODS.sectionsUpdate,
    }),
    moveSection: createEnvironmentRpcCommand(runtime, {
      label: "environment-sections:move",
      tag: WS_METHODS.sectionsMove,
    }),
    deleteSection: createEnvironmentRpcCommand(runtime, {
      label: "environment-sections:delete",
      tag: WS_METHODS.sectionsDelete,
    }),
    moveProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-sections:move-project",
      tag: WS_METHODS.sectionsMoveProject,
    }),
    retry: Atom.fn((environmentId: EnvironmentId, get) =>
      Effect.sync(() => get.refresh(rawSnapshotAtom(environmentId))),
    ).pipe(Atom.withLabel("environment-sections:retry")),
  };
}
