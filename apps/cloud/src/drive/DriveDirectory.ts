import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { Oid } from "./git/gitObjects.ts";
import type {
  DriveWriter,
  ObjectLocation,
  PackRegistration,
  RefWrite,
  StoredCommit,
  ThreadRefs,
} from "./DriveStore.ts";

/**
 * How the Worker and thread objects reach drive objects. Every drive has
 * exactly one, named by its drive id and always created in the EU
 * jurisdiction. Until shared drives land (#140), each person has one drive
 * per context, their My Drive, and every thread they start in that context
 * works in it.
 */

export const DRIVE_OBJECT_JURISDICTION = "eu";

/** A person's My Drive in a context. */
export const myDriveId = (contextId: SignalboxContextId, userId: string) =>
  `my/${contextId}/${userId}`;

/** What a drive object answers. `DriveObject` implements it method for method. */
export interface DriveObjectApi {
  readonly open: (writer: DriveWriter) => Promise<RefWrite>;
  readonly refs: (threadId: string | null) => Promise<ThreadRefs>;
  readonly ref: (name: string) => Promise<Oid | null>;
  readonly missing: (oids: ReadonlyArray<Oid>) => Promise<ReadonlyArray<Oid>>;
  readonly registerPack: (
    pack: PackRegistration,
  ) => Promise<
    { readonly _tag: "ok" } | { readonly _tag: "missing"; readonly oids: ReadonlyArray<Oid> }
  >;
  readonly updateRefs: (
    writer: DriveWriter,
    updates: ReadonlyArray<{ readonly name: string; readonly old: Oid | null; readonly new: Oid }>,
  ) => Promise<RefWrite>;
  readonly reconcile: (
    writer: DriveWriter,
    request: { readonly expectedMain: Oid | null; readonly newMain: Oid },
  ) => Promise<RefWrite>;
  readonly locate: (oids: ReadonlyArray<Oid>) => Promise<ReadonlyArray<ObjectLocation>>;
  readonly locateAt: (pack: string, offset: number) => Promise<ObjectLocation | null>;
  readonly commits: (oids: ReadonlyArray<Oid>) => Promise<ReadonlyArray<StoredCommit>>;
  readonly log: (from: Oid, limit: number) => Promise<ReadonlyArray<StoredCommit>>;
}

export class DriveObjectError extends Schema.TaggedError<DriveObjectError>()("DriveObjectError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Drive object call failed (${this.operation}).`;
  }
}

type Promised<F> = F extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Effect.Effect<R, DriveObjectError>
  : never;

/** A drive object's calls as Effects. */
export type DriveHandle = { readonly [K in keyof DriveObjectApi]: Promised<DriveObjectApi[K]> };

export function handleFor(api: DriveObjectApi): DriveHandle {
  const wrap =
    <K extends keyof DriveObjectApi>(operation: K) =>
    (...args: Array<unknown>) =>
      Effect.tryPromise({
        // Durable Object stubs dispatch by name, so the method is looked up per call.
        try: () => (api[operation] as (...a: Array<unknown>) => Promise<unknown>)(...args),
        catch: (cause) => new DriveObjectError({ operation, cause }),
      });
  return {
    open: wrap("open"),
    refs: wrap("refs"),
    ref: wrap("ref"),
    missing: wrap("missing"),
    registerPack: wrap("registerPack"),
    updateRefs: wrap("updateRefs"),
    reconcile: wrap("reconcile"),
    locate: wrap("locate"),
    locateAt: wrap("locateAt"),
    commits: wrap("commits"),
    log: wrap("log"),
  } as DriveHandle;
}

export class DriveDirectory extends Context.Service<
  DriveDirectory,
  { readonly forDrive: (driveId: string) => DriveHandle }
>()("@signalbox/cloud/drive/DriveDirectory") {}

/** The slice of the `DRIVES` Durable Object namespace binding callers use. */
export interface DriveObjectNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly jurisdiction: (name: typeof DRIVE_OBJECT_JURISDICTION) => {
    readonly idFromName: (name: string) => DurableObjectId;
  };
  readonly get: (id: DurableObjectId) => DriveObjectApi;
}

/** `localWorkerd`: local workerd has no jurisdictions, so `wrangler dev` uses the plain namespace. */
const driveObjectStub = (
  namespace: DriveObjectNamespace,
  driveId: string,
  options: { readonly localWorkerd: boolean },
) => {
  const ids = options.localWorkerd ? namespace : namespace.jurisdiction(DRIVE_OBJECT_JURISDICTION);
  return namespace.get(ids.idFromName(driveId));
};

export const layerDurableObjects = (
  namespace: DriveObjectNamespace,
  options: { readonly localWorkerd: boolean },
) =>
  Layer.succeed(
    DriveDirectory,
    DriveDirectory.of({
      forDrive: (driveId) => handleFor(driveObjectStub(namespace, driveId, options)),
    }),
  );
