import * as Effect from "effect/Effect";
import * as DriveDirectory from "./DriveDirectory.ts";
import type { MetadataBytes, MetadataState } from "./DriveMetadata.ts";
import { beginMetadataHash } from "./DriveMetadataHash.ts";
import * as DrivePacks from "./DrivePacks.ts";
import type { ObjectLocation } from "./DriveStore.ts";
import type { Oid } from "./git/gitObjects.ts";
import { makePackHydration } from "./metadata/hydrationPack.ts";
import {
  DriveHydrationError,
  type HydrationRemoteError,
  at,
  failure,
} from "./metadata/hydrationError.ts";
import {
  makeCheckpointCommit,
  loadCheckpoint,
  HYDRATION_BYTES,
  HYDRATION_DEPTH,
  type HydrationCheckpoint,
} from "./metadata/hydrationState.ts";

export { DriveHydrationError, HydrationRemoteError } from "./metadata/hydrationError.ts";

export interface HydrationRemoteRequest {
  readonly repository: string;
  readonly oid: Oid;
  readonly offset: number;
  readonly length: number;
  readonly knownSize?: number;
}
export type HydrationRemote = (
  input: HydrationRemoteRequest,
) => Effect.Effect<
  { readonly bytes: Uint8Array; readonly totalSize: number; readonly complete: boolean } | null,
  HydrationRemoteError
>;
export interface DriveHydration {
  readonly step: (
    oid: Oid,
    knownLocation?: ObjectLocation,
  ) => Effect.Effect<DriveHydrationProgress, DriveHydrationError>;
  readonly bytes: (
    oid: Oid,
    offset: number,
    maxBytes: number,
  ) => Effect.Effect<MetadataBytes, DriveHydrationError>;
}
export interface DriveHydrationProgress {
  readonly complete: boolean;
  readonly state: MetadataState;
  readonly kind: ObjectLocation["type"];
  readonly size: number | null;
}

const safeSize = (size: number) => Number.isSafeInteger(size) && size >= 0;

/** No live inflater, source buffer, or object body survives a step. */
export const makeDriveHydration = Effect.fn("makeDriveHydration")(function* (
  driveId: string,
  remote?: HydrationRemote,
): Effect.fn.Return<DriveHydration, never, DriveDirectory.DriveDirectory | DrivePacks.DrivePacks> {
  const drive = (yield* DriveDirectory.DriveDirectory).forDrive(driveId);
  const commit = yield* makeCheckpointCommit(driveId);
  const pack = yield* makePackHydration(driveId);
  const ensureRemoteSource = Effect.fn("DriveHydration.ensureRemoteSource")(function* (
    state: MetadataState,
  ) {
    if (state.source.kind !== "remote") return;
    const current = yield* at(state.oid, "source", drive.remote());
    if (current?.repository !== state.source.repository) return yield* failure(state.oid, "source");
  });
  const ensure = Effect.fn("DriveHydration.ensure")(function* (oid: Oid, known?: ObjectLocation) {
    const current = yield* at(oid, "state", drive.metadataStatus(oid));
    if (current !== null) {
      yield* ensureRemoteSource(current);
      return current;
    }
    const location = known ?? (yield* at(oid, "source", drive.locate([oid])))[0];
    if (location !== undefined) {
      if (location.oid !== oid) return yield* failure(oid, "source");
      return yield* at(oid, "state", drive.metadataBegin(oid, { kind: "pack", location })).pipe(
        Effect.tap(ensureRemoteSource),
      );
    }
    const [promised] = yield* at(oid, "source", drive.promised([oid]));
    const origin = yield* at(oid, "source", drive.remote());
    if (promised?.oid !== oid || origin === null || remote === undefined)
      return yield* failure(oid, "source");
    return yield* at(
      oid,
      "state",
      drive.metadataBegin(oid, {
        kind: "remote",
        repository: origin.repository,
        size: promised.size,
      }),
    ).pipe(Effect.tap(ensureRemoteSource));
  });
  const remoteStep = Effect.fn("DriveHydration.remoteStep")(function* (
    state: MetadataState,
    cp: HydrationCheckpoint | null,
  ) {
    if (
      state.source.kind !== "remote" ||
      remote === undefined ||
      (cp !== null && cp.kind !== "remote") ||
      (cp === null && state.bytesWritten !== 0)
    )
      return yield* failure(state.oid, "source");
    const knownSize = cp?.size ?? state.source.size;
    const length = Math.max(
      1,
      Math.min(
        HYDRATION_BYTES,
        knownSize === null ? HYDRATION_BYTES : knownSize - state.bytesWritten,
      ),
    );
    const found = yield* at(
      state.oid,
      "range",
      remote({
        repository: state.source.repository,
        oid: state.oid,
        offset: state.bytesWritten,
        length,
        ...(knownSize === null ? {} : { knownSize }),
      }),
    );
    if (
      found === null ||
      !safeSize(found.totalSize) ||
      found.bytes.length > length ||
      (knownSize !== null && knownSize !== found.totalSize) ||
      state.bytesWritten + found.bytes.length > found.totalSize ||
      found.complete !== (state.bytesWritten + found.bytes.length === found.totalSize) ||
      (!found.complete && found.bytes.length === 0)
    )
      return yield* failure(state.oid, "range");
    return yield* commit(
      state,
      cp ?? {
        format: "drive-hydration-v1",
        kind: "remote",
        size: found.totalSize,
        hash: beginMetadataHash("blob", found.totalSize),
      },
      found.bytes,
      found.complete,
    );
  });
  const step = Effect.fn("DriveHydration.step")(function* (
    oid: Oid,
    knownLocation?: ObjectLocation,
  ) {
    const progress = Effect.fn("DriveHydration.progress")(function* (state: MetadataState) {
      yield* ensureRemoteSource(state);
      const cp =
        state.source.kind === "remote" &&
        state.source.size === null &&
        state.checkpoint !== null &&
        !state.complete
          ? yield* loadCheckpoint(state)
          : null;
      return {
        complete: state.complete,
        state,
        kind: state.source.kind === "pack" ? state.source.location.type : "blob",
        size: state.complete
          ? state.bytesWritten
          : state.source.kind === "pack"
            ? state.source.location.size
            : (state.source.size ?? (cp?.kind === "remote" ? cp.size : null)),
      } satisfies DriveHydrationProgress;
    });
    const root = yield* ensure(oid, knownLocation);
    if (root.complete) return yield* progress(root);
    let current = root;
    const visited = new Set<Oid>();
    for (;;) {
      if (visited.has(current.oid) || visited.size >= HYDRATION_DEPTH)
        return yield* failure(current.oid, "dependency");
      visited.add(current.oid);
      const cp = current.checkpoint === null ? null : yield* loadCheckpoint(current);
      let updated: MetadataState;
      if (current.source.kind === "remote") updated = yield* remoteStep(current, cp);
      else if (cp === null) updated = yield* pack.initialize(current, visited);
      else {
        if (cp.kind !== "pack") return yield* failure(current.oid, "checkpoint");
        const base = cp.baseOid === null ? null : yield* ensure(cp.baseOid);
        if (base !== null && !base.complete) {
          current = base;
          continue;
        }
        updated = yield* pack.step(current, cp, base);
      }
      const state =
        current.oid === oid
          ? updated
          : ((yield* at(oid, "state", drive.metadataStatus(oid))) ?? root);
      return yield* progress(state);
    }
  });
  return {
    step,
    bytes: Effect.fn("DriveHydration.bytes")(function* (
      oid: Oid,
      offset: number,
      maxBytes: number,
    ) {
      const state = yield* at(oid, "state", drive.metadataStatus(oid));
      if (state === null) return yield* failure(oid, "state");
      yield* ensureRemoteSource(state);
      const bytes = yield* at(oid, "range", drive.metadataBytes(oid, offset, maxBytes));
      yield* ensureRemoteSource(state);
      return bytes;
    }),
  };
});
