import type { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import type { SignalboxDriveMember, SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { Oid } from "./git/gitObjects.ts";
import type {
  HistoryOrigin,
  HistoryResult,
  HistorySnapshot,
  HistoryStartResult,
} from "./DriveHistory.ts";
import type { AccessDelivery, DrivePerson, MembershipChange } from "./DriveMembers.ts";
import type {
  MetadataAdvance,
  MetadataAdvanceResult,
  MetadataBytes,
  MetadataSource,
  MetadataState,
} from "./DriveMetadata.ts";
import type {
  DriveWriter,
  CheckpointOperationResult,
  ForkCheckpointRequest,
  ObjectLocation,
  PackRegistration,
  PromisedFile,
  RefWrite,
  RestoreCheckpointRequest,
  UndoRestoreRequest,
  Shortcut,
  ShortcutChange,
  StoredCommit,
  UpdateToLatestRequest,
  UnreconciledWork,
  ThreadRefs,
} from "./DriveStore.ts";
import type { DriveCheckpointRecord } from "@signalbox/runner-protocol/DriveProtocol";
import type { PullResult, PullSaveRequest } from "@signalbox/runner-protocol/PullProtocol";

import type {
  DrivePublicationRequest,
  DrivePublicationResult,
  RecordPublicationCreatedRequest,
  BindPublicationRequest,
} from "./DrivePublicationTypes.ts";

/**
 * How the Worker, thread and user objects reach drive objects. Every drive
 * has exactly one, named by its drive id (`driveAccess.ts`) and always
 * created in the EU jurisdiction.
 * A drive backed by a remote repository (#135) records it, and its `main`
 * mirrors the remote.
 */

export const DRIVE_OBJECT_JURISDICTION = "eu";

/** What a drive object answers. `DriveObject` implements it method for method. */
export interface DriveObjectApi {
  readonly beginPublication: (
    userId: string,
    request: DrivePublicationRequest,
  ) => Promise<DrivePublicationResult>;
  readonly markPublicationCreating: (userId: string, id: string) => Promise<DrivePublicationResult>;
  readonly releasePublicationCreating: (
    userId: string,
    id: string,
  ) => Promise<DrivePublicationResult>;
  readonly recordPublicationCreated: (
    userId: string,
    request: RecordPublicationCreatedRequest,
  ) => Promise<DrivePublicationResult>;
  readonly bindPublication: (
    userId: string,
    request: BindPublicationRequest,
  ) => Promise<DrivePublicationResult>;
  readonly finishPublication: (userId: string, id: string) => Promise<DrivePublicationResult>;
  readonly packStorage: (name: string) => Promise<string | null>;
  readonly history: (userId: string) => Promise<HistoryResult>;
  readonly historyOrigin: (userId: string) => Promise<HistoryOrigin | null>;
  readonly startFromHistory: (
    userId: string,
    history: HistorySnapshot,
  ) => Promise<HistoryStartResult>;
  readonly open: (writer: DriveWriter) => Promise<RefWrite>;
  readonly refs: (threadId: string | null, packsAfter?: number) => Promise<ThreadRefs>;
  readonly ref: (name: string) => Promise<Oid | null>;
  readonly missing: (
    oids: ReadonlyArray<Oid>,
    visibleTo: string | null,
  ) => Promise<ReadonlyArray<Oid>>;
  readonly promised: (oids: ReadonlyArray<Oid>) => Promise<ReadonlyArray<PromisedFile>>;
  readonly registerPack: (
    pack: PackRegistration,
  ) => Promise<
    { readonly _tag: "ok" } | { readonly _tag: "missing"; readonly oids: ReadonlyArray<Oid> }
  >;
  readonly updateRefs: (
    writer: DriveWriter,
    updates: ReadonlyArray<{ readonly name: string; readonly old: Oid | null; readonly new: Oid }>,
  ) => Promise<RefWrite>;
  readonly savePull: (writer: DriveWriter, request: PullSaveRequest) => Promise<PullResult>;
  readonly pullReceipt: (writer: DriveWriter, id: string) => Promise<PullResult | null>;
  readonly reconcile: (
    writer: DriveWriter,
    request: { readonly expectedMain: Oid | null; readonly newMain: Oid },
  ) => Promise<RefWrite>;
  readonly setRemote: (remote: DriveRemote) => Promise<void>;
  readonly remote: () => Promise<DriveRemote | null>;
  readonly mirror: (
    writer: DriveWriter,
    request: { readonly expectedMain: Oid | null; readonly newMain: Oid },
  ) => Promise<RefWrite>;
  readonly locate: (oids: ReadonlyArray<Oid>) => Promise<ReadonlyArray<ObjectLocation>>;
  readonly locateAt: (pack: string, offset: number) => Promise<ObjectLocation | null>;
  readonly metadataBegin: (oid: Oid, source: MetadataSource) => Promise<MetadataState>;
  readonly metadataStatus: (oid: Oid) => Promise<MetadataState | null>;
  readonly metadataAdvance: (input: MetadataAdvance) => Promise<MetadataAdvanceResult>;
  readonly metadataBytes: (oid: Oid, offset: number, maxBytes: number) => Promise<MetadataBytes>;
  readonly commits: (oids: ReadonlyArray<Oid>) => Promise<ReadonlyArray<StoredCommit>>;
  readonly log: (from: Oid, limit: number) => Promise<ReadonlyArray<StoredCommit>>;
  readonly replaceMain: (
    userId: string,
    request: {
      readonly expectedMain: Oid | null;
      readonly newMain: Oid;
      readonly shortcut?: Shortcut;
    },
  ) => Promise<RefWrite>;
  readonly shortcuts: () => Promise<ReadonlyArray<Shortcut>>;
  readonly addShortcut: (userId: string, shortcut: Shortcut) => Promise<ShortcutChange>;
  readonly removeShortcut: (userId: string, path: string) => Promise<ShortcutChange>;
  readonly unreconciled: (input: {
    readonly limit: number;
    readonly threadId?: string;
  }) => Promise<ReadonlyArray<UnreconciledWork>>;
  /** Names the drive and seats its first members; idempotent. */
  readonly setup: (input: {
    readonly name: string;
    readonly members: ReadonlyArray<DrivePerson & { readonly role: SignalboxDriveRole }>;
  }) => Promise<void>;
  /** Not `name`: a Durable Object stub has its own `name` property. */
  readonly driveName: () => Promise<string | null>;
  readonly role: (userId: string) => Promise<SignalboxDriveRole | null>;
  readonly members: () => Promise<ReadonlyArray<SignalboxDriveMember>>;
  readonly share: (
    by: DrivePerson,
    person: DrivePerson,
    role: SignalboxDriveRole,
  ) => Promise<MembershipChange>;
  readonly unshare: (
    by: DrivePerson,
    userId: string,
  ) => Promise<{ readonly _tag: "ok" } | { readonly _tag: "refused"; readonly reason: string }>;
  /** Membership changes not yet in their people's indexes. */
  readonly pendingAccess: () => Promise<ReadonlyArray<AccessDelivery>>;
  readonly recordCheckpoint: (
    writer: DriveWriter,
    record: DriveCheckpointRecord,
  ) => Promise<RefWrite>;
  readonly checkpoint: (threadId: string, runId: string) => Promise<DriveCheckpointRecord | null>;
  readonly forkCheckpoint: (
    userId: string,
    request: ForkCheckpointRequest,
  ) => Promise<CheckpointOperationResult>;
  readonly restoreCheckpoint: (
    userId: string,
    request: RestoreCheckpointRequest,
  ) => Promise<CheckpointOperationResult>;
  readonly undoRestore: (
    userId: string,
    request: UndoRestoreRequest,
  ) => Promise<CheckpointOperationResult>;
  readonly updateToLatest: (
    userId: string,
    request: UpdateToLatestRequest,
  ) => Promise<CheckpointOperationResult>;
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
    beginPublication: wrap("beginPublication"),
    markPublicationCreating: wrap("markPublicationCreating"),
    releasePublicationCreating: wrap("releasePublicationCreating"),
    recordPublicationCreated: wrap("recordPublicationCreated"),
    bindPublication: wrap("bindPublication"),
    finishPublication: wrap("finishPublication"),
    packStorage: wrap("packStorage"),
    history: wrap("history"),
    historyOrigin: wrap("historyOrigin"),
    startFromHistory: wrap("startFromHistory"),
    open: wrap("open"),
    refs: wrap("refs"),
    ref: wrap("ref"),
    missing: wrap("missing"),
    promised: wrap("promised"),
    registerPack: wrap("registerPack"),
    updateRefs: wrap("updateRefs"),
    savePull: wrap("savePull"),
    pullReceipt: wrap("pullReceipt"),
    reconcile: wrap("reconcile"),
    setRemote: wrap("setRemote"),
    remote: wrap("remote"),
    mirror: wrap("mirror"),
    locate: wrap("locate"),
    locateAt: wrap("locateAt"),
    metadataBegin: wrap("metadataBegin"),
    metadataStatus: wrap("metadataStatus"),
    metadataAdvance: wrap("metadataAdvance"),
    metadataBytes: wrap("metadataBytes"),
    commits: wrap("commits"),
    log: wrap("log"),
    replaceMain: wrap("replaceMain"),
    shortcuts: wrap("shortcuts"),
    addShortcut: wrap("addShortcut"),
    removeShortcut: wrap("removeShortcut"),
    unreconciled: wrap("unreconciled"),
    setup: wrap("setup"),
    driveName: wrap("driveName"),
    role: wrap("role"),
    members: wrap("members"),
    share: wrap("share"),
    unshare: wrap("unshare"),
    pendingAccess: wrap("pendingAccess"),
    recordCheckpoint: wrap("recordCheckpoint"),
    checkpoint: wrap("checkpoint"),
    forkCheckpoint: wrap("forkCheckpoint"),
    restoreCheckpoint: wrap("restoreCheckpoint"),
    undoRestore: wrap("undoRestore"),
    updateToLatest: wrap("updateToLatest"),
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
