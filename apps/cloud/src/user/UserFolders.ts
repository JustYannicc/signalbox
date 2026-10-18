import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FolderCreateInput,
  type FolderDeleteInput,
  FolderId,
  type FolderMoveInput,
  OnePasswordEnvironmentId,
  type FolderMoveThreadInput,
  FolderOrigin,
  type FolderSetInstructionsInput,
  type FolderSetOnePasswordInput,
  type FolderSetPhaseInput,
  type FolderSetSecretsInput,
  type FolderUpdateInput,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";
import { NoteId } from "@t3tools/contracts/signalboxNotes";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { parseDriveId } from "../drive/driveAccess.ts";
import type { TurnInstructions, TurnPools, TurnSecrets } from "../thread/turnPool.ts";
import { contextOfProject, driveOfProject, projectIdForDrive } from "./contextProjects.ts";
import { foldDrives } from "./driveFolders.ts";
import * as FolderStartReservations from "./folderStartReservations.ts";
import {
  columnsOfPhase,
  initialPhase,
  nextPhase,
  phaseOfColumns,
  samePhase,
} from "./folderPhases.ts";
import { toSnapshot } from "./folderSnapshot.ts";
import {
  childIds,
  currentProjectIds,
  folderOfProject,
  homeOf,
  insertBefore,
  instructionsOf,
  isWithin,
  levelOf,
  poolResolver,
  sameOrder,
  secretsOf,
  type Tree,
  type TreeFolder,
  withSoundParents,
} from "./folderTree.ts";
import {
  decodeFolderRows,
  decodePlacementRows,
  decodeSectionRows,
  type FolderRow,
  type FolderRows,
  type SectionRows,
} from "./folderRows.ts";
import * as OnePasswordAccount from "./OnePasswordAccount.ts";
import { makeProfileId } from "./profileId.ts";
import { makeTraced } from "./tracing.ts";
import * as ResourceBindings from "./ResourceBindings.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as FolderTrashStore from "./folderTrash.ts";

const encodeTrashFolderIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(FolderId)));
const encodeTrashDriveIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeTrashThreadIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ThreadId)));
const encodeTrashNoteIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(NoteId)));

/**
 * The user's folders, in their own object (#227): the one kind of level
 * below the top, nesting freely. A folder belongs to one owner's tree
 * (Personal or a work organization) and never leaves it. It can use one of
 * the user's drives as its files; each drive the user is given gets a folder
 * of its own once, at the top of its owner's tree, which they can then move,
 * rename or take the files from. Folders decide what threads run on, never
 * where anything is stored or who can reach it (`folderTree.ts`).
 *
 * Folders replace sections and their projects' placements. `0013` copies
 * every section into a folder with the same id, and files threads of a My
 * Drive placed in a section in it. A drive's folder takes its old project
 * placement the first time it's made, and its project's id as its own, so a
 * pool placed at a section or a project still applies (`ResourceBindings`).
 */

/** Why a change was refused, for the user. `not-found`: the folder is gone. */
export class FolderRefusedError extends Schema.TaggedError<FolderRefusedError>()(
  "FolderRefusedError",
  { reason: Schema.Literals(["not-found", "invalid"]), message: Schema.String },
) {}

/** A thread is filed into a folder hidden in Trash and cannot use a fallback chain. */
export class ThreadHomeTrashedError extends Schema.TaggedError<ThreadHomeTrashedError>()(
  "ThreadHomeTrashedError",
  { folderId: FolderId },
) {
  override get message(): string {
    return "This thread's folder is in Trash.";
  }
}

type Failure = FolderRefusedError | SqlError;

export interface FolderTrashOutcome {
  readonly trash: FolderTrashStore.Record;
  readonly snapshot: SignalboxFoldersSnapshot;
}

export interface FolderTrashRestoreOutcome extends FolderTrashOutcome {
  readonly restored: boolean;
}

export interface FolderTrashRestorePreflight {
  readonly status: FolderTrashStore.Record["status"];
  readonly parentTrashedAt: number | null;
}

/** Everything a change is decided from. */
export interface FolderState {
  readonly contexts: ReadonlyArray<SignalboxContext>;
  /** Drives others gave the user, in their current owners' trees. */
  readonly drives: ReadonlyArray<UserDriveIndex.IndexedDrive>;
  readonly tree: Tree;
  readonly revision: number;
  /** When the user's 1Password service account was connected; null when none is. */
  readonly onePasswordConnectedAt: number | null;
  /** The folders the user lent a GitHub account to (#641). */
  readonly githubLends: ReadonlyMap<FolderId, ResourceBindings.GitHubLend>;
}

export class UserFolders extends Context.Service<
  UserFolders,
  {
    readonly state: Effect.Effect<FolderState, SqlError>;
    /** The state now, then again after every change, owners' and drives' included. */
    readonly states: Stream.Stream<FolderState, SqlError>;
    readonly snapshot: Effect.Effect<SignalboxFoldersSnapshot, SqlError>;
    /** Where a thread lives now (`homeOf`), with the state that says so. */
    readonly threadHome: (
      threadId: ThreadId,
      fallback?: { readonly projectId: ProjectId; readonly ownerId: SignalboxContextId },
    ) => Effect.Effect<{ readonly state: FolderState; readonly home: FolderId | null }, SqlError>;
    /** `states` as snapshots. */
    readonly changes: Stream.Stream<SignalboxFoldersSnapshot, SqlError>;
    readonly create: (input: FolderCreateInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    /** Reserves source identity, name and drive before preparing the history. */
    readonly reserveStart: (
      input: FolderStartReservations.FolderStartReservationInput,
    ) => Effect.Effect<{ readonly name: string; readonly sourceName: string }, Failure>;
    /** Adds the prepared drive and its immutable source lineage at the tree's top level. */
    readonly createFrom: (input: {
      readonly id: FolderId;
      readonly name: string;
      readonly ownerId: SignalboxContextId;
      readonly driveId: string;
      readonly origin: FolderOrigin;
    }) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly update: (input: FolderUpdateInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly move: (input: FolderMoveInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly delete: (input: FolderDeleteInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    /** Hides a folder and its active descendants while retaining every row for 30-day restore. */
    readonly trash: (input: FolderDeleteInput) => Effect.Effect<FolderTrashOutcome, Failure>;
    readonly restoreTrash: (
      trashId: string,
      requestedAt?: number,
    ) => Effect.Effect<FolderTrashRestoreOutcome, Failure>;
    /** Reads one durable folder-trash receipt, including completed receipts for stale-job fencing. */
    readonly trashDetails: (
      trashId: string,
    ) => Effect.Effect<FolderTrashStore.Record | null, SqlError>;
    /** The current local receipt and parent state for a restore decision. */
    readonly restorePreflight: (
      trashId: string,
    ) => Effect.Effect<FolderTrashRestorePreflight | null, SqlError>;
    /** Receipts still awaiting restore or purge, for service recovery after a restart. */
    readonly activeTrashes: Effect.Effect<ReadonlyArray<FolderTrashStore.Record>, SqlError>;
    readonly moveThread: (
      input: FolderMoveThreadInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly setInstructions: (
      input: FolderSetInstructionsInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    /** Moves a folder to another of its phases, edits the list, or takes its phase away (#677). */
    readonly setPhase: (
      input: FolderSetPhaseInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    /** Names a level's 1Password Environment (#395), or stops loading secrets there. */
    readonly setSecrets: (
      input: FolderSetSecretsInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    /** Connects the user's 1Password service account, replacing any before, or disconnects it. */
    readonly setOnePassword: (
      input: FolderSetOnePasswordInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    /** Connects `token` only when no account is: a preview taking production's (`previewSetup/`). */
    readonly adoptOnePassword: (token: string) => Effect.Effect<void, SqlError>;
    /**
     * Lends GitHub account `login` to a folder for its CI steps, or stops (null).
     * `GitHubActions.setLend` decides the login: the user's connected account.
     */
    readonly setGitHubLend: (
      folderId: FolderId,
      login: string | null,
    ) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    /** Takes a deleted pool off every level, so they inherit from above again. */
    readonly forgetPool: (poolId: string) => Effect.Effect<void, SqlError>;
    /**
     * What a thread's next turn runs on and follows, from its home's chain.
     * `projectId`: the thread's, when the caller knows it (a create does).
     */
    readonly turn: (thread: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId | null;
    }) => Effect.Effect<
      {
        readonly pools: TurnPools;
        readonly instructions: TurnInstructions;
        readonly secrets: TurnSecrets;
      },
      SqlError | ThreadHomeTrashedError
    >;
    /** Whether a drive is attached to a folder hidden in Trash. */
    readonly driveIsTrashed: (driveId: string) => Effect.Effect<boolean, SqlError>;
    /** The thread's effective home, if that folder is currently hidden in Trash. */
    readonly trashedHomeOfThread: (threadId: ThreadId) => Effect.Effect<FolderId | null, SqlError>;
    /** Active folders and bindings for previews; trashed rows stay in this user's store. */
    readonly rows: Effect.Effect<FolderRows, SqlError>;
    /** Adds rows another of this user's clouds holds, never over ones here. */
    readonly adopt: (rows: FolderRows) => Effect.Effect<void, SqlError>;
    /** Sections and placements as stored before folders, for previews still on them. */
    readonly legacyRows: Effect.Effect<SectionRows, SqlError>;
    /** `adopt` for a cloud from before folders: its sections become folders, as `0013` makes them. */
    readonly adoptLegacy: (rows: SectionRows) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/user/UserFolders") {}

const HomeRow = Schema.Struct({ thread_id: ThreadId, folder_id: Schema.NullOr(FolderId) });
const decodeHomeRows = Schema.decodeUnknownSync(Schema.Array(HomeRow));
const decodeIndexed = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ context_id: SignalboxContextId, project_id: ProjectId })),
);
const decodeState = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      revision: Schema.Number,
      instructions: Schema.NullOr(Schema.String),
      secrets_environment_id: Schema.NullOr(OnePasswordEnvironmentId),
    }),
  ),
);
const encodeOrigin = Schema.encodeSync(Schema.fromJsonString(FolderOrigin));
const toTreeFolder = (row: typeof FolderRow.Type): TreeFolder => ({
  id: row.id,
  ownerId: row.owner_id,
  parentId: row.parent_id,
  name: row.name,
  position: row.position,
  driveId: row.drive_id,
  origin: row.origin ?? null,
  instructions: row.instructions,
  secrets: row.secrets_environment_id ?? null,
  phase: phaseOfColumns(row.phases, row.phase),
});

/** How long a filing waits for its thread to be created before the next filing drops it. */
const UNCLAIMED_FILING_MS = 24 * 60 * 60 * 1000;

const refuse = (message: string, reason: "not-found" | "invalid" = "invalid") =>
  Effect.fail(new FolderRefusedError({ reason, message }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const contexts = yield* UserContexts.UserContexts;
  const driveIndex = yield* UserDriveIndex.UserDriveIndex;
  // `UserStore`'s profile and thread index, read here: importing it would be a
  // cycle (it runs the pools' migration, and pools forget themselves here).
  const userId = yield* makeProfileId;
  /** An indexed thread's owner and project, or null when it isn't indexed. */
  const indexedThread = (threadId: ThreadId) =>
    Effect.map(
      sql`SELECT context_id, json_extract(shell, '$.projectId') AS project_id
        FROM thread_index WHERE thread_id = ${threadId}`,
      (rows) => {
        const [row] = decodeIndexed(rows);
        return row === undefined ? null : { contextId: row.context_id, projectId: row.project_id };
      },
    );
  const bindings = yield* ResourceBindings.ResourceBindings;
  const onePassword = yield* OnePasswordAccount.OnePasswordAccount;
  // Own changes and owner or drive changes share one signal, so a subscriber
  // that subscribes before its first read misses neither.
  const changed = yield* PubSub.sliding<void>(1);
  yield* contexts.contextsChanged.pipe(
    Stream.runForEach(() => PubSub.publish(changed, undefined)),
    Effect.forkScoped,
  );

  const bump = sql`UPDATE folders_state SET revision = revision + 1 WHERE id = 1`;
  const selectFolders = sql`SELECT id, owner_id, parent_id, name, position, drive_id, instructions,
    secrets_environment_id, phases, phase, origin FROM folders WHERE trash_id IS NULL`;
  const selectState = sql`SELECT revision, instructions, secrets_environment_id FROM folders_state`;
  const selectTrashColumns = sql`SELECT trash_id, folder_id, owner_id, title, parent_id, position,
    folder_ids, drive_ids, thread_ids, note_ids, deleted_at, restore_until, status FROM folder_trash`;
  const readTrash = (trashId: string) =>
    Effect.map(
      sql`${selectTrashColumns} WHERE trash_id = ${trashId}`,
      (rows) => FolderTrashStore.decodeRecords(rows)[0] ?? null,
    );
  const trashDetails: UserFolders["Service"]["trashDetails"] = readTrash;
  const restorePreflight: UserFolders["Service"]["restorePreflight"] = (trashId) =>
    Effect.gen(function* () {
      const record = yield* readTrash(trashId);
      if (record === null) return null;
      if (record.parentId === null) return { status: record.status, parentTrashedAt: null };
      const [parent] = yield* sql<{ readonly trashed_at: number | null }>`SELECT trashed_at
        FROM folders WHERE id = ${record.parentId} AND trash_id IS NOT NULL`;
      return { status: record.status, parentTrashedAt: parent?.trashed_at ?? null };
    });
  const activeTrashes: UserFolders["Service"]["activeTrashes"] = Effect.map(
    sql`${selectTrashColumns} WHERE status = 'trashed' ORDER BY deleted_at, trash_id`,
    FolderTrashStore.decodeRecords,
  );

  /** A span for one operation (`tracing.ts`): never a folder's name or instructions. */
  const traced = makeTraced(userId);
  /** The tree a decided change was in, once known. */
  const annotateOwner = (ownerId: string) => Effect.annotateCurrentSpan("org.id", ownerId);

  /** The user's current owners, and the drives others gave them in those owners' trees. */
  const owned = Effect.gen(function* () {
    const current = yield* contexts.contexts;
    const owners = new Set<string>(current.map((context) => context.id));
    const drives = (yield* driveIndex.drives).filter((drive) =>
      owners.has(parseDriveId(drive.driveId)?.contextId ?? ""),
    );
    return { contexts: current, owners, drives };
  });
  type Owned = Effect.Success<typeof owned>;

  /**
   * The tree, only what belongs to a current owner: folders of organizations
   * the user left stay out of sight. `filedOnly`: read just that thread's filing.
   */
  const load = (at: Owned, filedOnly?: ThreadId) =>
    Effect.gen(function* () {
      const user = yield* userId;
      const folders = decodeFolderRows(yield* selectFolders)
        .filter((row) => at.owners.has(row.owner_id))
        .map(toTreeFolder);
      const homes = decodeHomeRows(
        filedOnly === undefined
          ? yield* sql`SELECT thread_id, folder_id FROM thread_homes`
          : yield* sql`SELECT thread_id, folder_id FROM thread_homes WHERE thread_id = ${filedOnly}`,
      );
      const [state] = decodeState(yield* selectState);
      const tree: Tree = {
        folders: withSoundParents(folders),
        topInstructions: state?.instructions ?? null,
        topSecrets: state?.secrets_environment_id ?? null,
        bindings: yield* bindings.pools,
        filed: new Map(homes.map((row) => [row.thread_id, row.folder_id])),
        driveOfProject: (projectId) => (user === null ? null : driveOfProject(projectId, user)),
      };
      return {
        contexts: at.contexts,
        drives: at.drives,
        tree,
        revision: state?.revision ?? 0,
        onePasswordConnectedAt: yield* onePassword.connectedAt,
        githubLends: yield* bindings.githubLends,
      } satisfies FolderState;
    });

  /**
   * Gives drives new to the user their folders (`driveFolders.ts`). Only a
   * drive not seen before opens a transaction; answers whether it made any.
   */
  const foldNew = (drives: ReadonlyArray<UserDriveIndex.IndexedDrive>) =>
    Effect.gen(function* () {
      const done = new Set(
        (yield* sql<{ readonly drive_id: string }>`SELECT drive_id FROM folder_drives`).map(
          (row) => row.drive_id,
        ),
      );
      if (drives.every((drive) => done.has(drive.driveId))) return false;
      const made = yield* sql.withTransaction(
        foldDrives(drives).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.tap((folded) => (folded ? Effect.asVoid(bump) : Effect.void)),
        ),
      );
      if (made) yield* PubSub.publish(changed, undefined);
      return made;
    });

  const state: UserFolders["Service"]["state"] = Effect.gen(function* () {
    const at = yield* owned;
    yield* foldNew(at.drives);
    return yield* load(at);
  });

  const snapshot: UserFolders["Service"]["snapshot"] = Effect.map(state, toSnapshot);

  const threadHome: UserFolders["Service"]["threadHome"] = (threadId, fallback) =>
    Effect.gen(function* () {
      const current = yield* state;
      const indexed = yield* indexedThread(threadId);
      const home = homeOf(current.tree, {
        threadId,
        projectId: indexed?.projectId ?? fallback?.projectId ?? null,
        ownerId: indexed?.contextId ?? fallback?.ownerId ?? null,
      });
      return { state: current, home };
    });

  const states: UserFolders["Service"]["states"] = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.prepend([undefined]),
        Stream.mapEffect(() => state),
      ),
    ),
  );

  /**
   * Decides and applies one change in a transaction; `decide` answers whether
   * anything changed. A change bumps the revision and reaches every subscriber.
   */
  const mutate = (decide: (current: FolderState) => Effect.Effect<boolean, Failure>) =>
    Effect.gen(function* () {
      const at = yield* owned;
      // New drives get their folders first, so a change can name them.
      yield* foldNew(at.drives);
      const changedAnything = yield* sql.withTransaction(
        Effect.gen(function* () {
          const decided = yield* decide(yield* load(at));
          if (decided) yield* bump;
          return decided;
        }),
      );
      if (changedAnything) yield* PubSub.publish(changed, undefined);
      return toSnapshot(yield* load(at));
    });

  const requireFolder = (current: FolderState, id: FolderId) => {
    const folder = current.tree.folders.find((candidate) => candidate.id === id);
    return folder ? Effect.succeed(folder) : refuse("That folder no longer exists.", "not-found");
  };

  const setOrder = (parentId: FolderId | null, ids: ReadonlyArray<FolderId>) =>
    Effect.forEach(
      ids,
      (id, position) =>
        sql`UPDATE folders SET parent_id = ${parentId}, position = ${position} WHERE id = ${id}`,
      { discard: true },
    );

  const create: UserFolders["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const id = FolderId.make(yield* Effect.orDie(crypto.randomUUIDv4()));
      return yield* mutate((current) =>
        Effect.gen(function* () {
          const parent =
            input.parentId === null ? null : yield* requireFolder(current, input.parentId);
          const ownerId = parent?.ownerId ?? input.ownerId ?? PERSONAL_CONTEXT_ID;
          yield* annotateOwner(ownerId);
          const owner = current.contexts.find((context) => context.id === ownerId);
          if (owner === undefined) {
            return yield* refuse("Choose Personal or one of your organizations for the folder.");
          }
          if (parent !== null && input.ownerId !== undefined && input.ownerId !== ownerId) {
            return yield* refuse("A folder belongs to its parent's owner.");
          }
          const order = insertBefore(
            childIds(current.tree, ownerId, input.parentId),
            id,
            input.beforeId,
          );
          if (order === undefined) return yield* refuse("That position is not a sibling.");
          const phase = initialPhase(owner.kind, input.phases);
          if ("refused" in phase) return yield* refuse(phase.refused);
          const columns = columnsOfPhase(phase.phase);
          yield* sql`INSERT INTO folders (id, owner_id, parent_id, name, position, phases, phase)
            VALUES (${id}, ${ownerId}, ${input.parentId}, ${input.name.trim()}, 0,
              ${columns.phases}, ${columns.phase})`;
          yield* setOrder(input.parentId, order);
          return true;
        }),
      );
    }).pipe(traced("UserFolders.create", { "folder.parent_id": input.parentId }));

  const reserveStart: UserFolders["Service"]["reserveStart"] = (input) =>
    FolderStartReservations.reserve(input).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.flatMap((reservation) =>
        reservation === null
          ? refuse("That folder already exists with a different source.")
          : Effect.succeed(reservation),
      ),
    );

  const createFrom: UserFolders["Service"]["createFrom"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const existing = current.tree.folders.find((folder) => folder.id === input.id);
        if (existing !== undefined) {
          const sameOrigin =
            existing.origin?.legacyCatalogHome === input.origin.legacyCatalogHome &&
            existing.origin?.folderId === input.origin.folderId &&
            existing.origin?.driveId === input.origin.driveId &&
            existing.origin?.head === input.origin.head;
          return existing.ownerId === input.ownerId &&
            existing.driveId === input.driveId &&
            sameOrigin
            ? false
            : yield* refuse("That folder already exists.");
        }
        yield* annotateOwner(input.ownerId);
        if (!current.contexts.some((context) => context.id === input.ownerId)) {
          return yield* refuse("Choose one of your current contexts for the folder.");
        }
        const order = [...childIds(current.tree, input.ownerId, null), input.id];
        yield* sql`INSERT INTO folders (id, owner_id, parent_id, name, position, drive_id, origin)
          VALUES (${input.id}, ${input.ownerId}, NULL, ${input.name.trim()}, 0,
            ${input.driveId}, ${encodeOrigin(input.origin)})`;
        yield* FolderStartReservations.complete(input.id).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        yield* setOrder(null, order);
        return true;
      }),
    ).pipe(traced("UserFolders.createFrom", { "folder.id": input.id }));

  /** The drive `projectId` names, when it can be a folder's files: given to the user, in `ownerId`'s tree. */
  const filesFor = (current: FolderState, projectId: ProjectId, ownerId: string) => {
    return Effect.gen(function* () {
      const drive = current.drives.find(
        (candidate) => projectIdForDrive(candidate.driveId) === projectId,
      );
      if (drive === undefined) {
        return yield* refuse(
          "Choose a shared drive or a shared folder. Your own files stay at the top level.",
        );
      }
      if (parseDriveId(drive.driveId)?.contextId !== ownerId) {
        return yield* refuse("Those files belong to another owner's folders.");
      }
      const [trashed] = yield* sql`SELECT 1 FROM folders
        WHERE drive_id = ${drive.driveId} AND trash_id IS NOT NULL`;
      if (trashed !== undefined) {
        return yield* refuse(
          "Those files are in a folder in Trash. Restore it before moving them.",
        );
      }
      return drive.driveId;
    });
  };

  const update: UserFolders["Service"]["update"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const folder = yield* requireFolder(current, input.id);
        yield* annotateOwner(folder.ownerId);
        let changedAnything = false;
        if (input.poolId !== undefined) {
          const pool = yield* bindings.setPool(levelOf(folder.id), input.poolId);
          if (!pool.known) return yield* refuse("Choose one of your pools.");
          changedAnything ||= pool.changed;
        }
        if (input.files !== undefined) {
          const driveId =
            input.files === null ? null : yield* filesFor(current, input.files, folder.ownerId);
          if (driveId !== folder.driveId) {
            // A lend was for the repository the files were; other files need lending again.
            yield* bindings.setGitHubLend(folder.id, null);
            if (driveId !== null) {
              const from = current.tree.folders.find((entry) => entry.driveId === driveId);
              if (from) yield* bindings.setGitHubLend(from.id, null);
              yield* sql`UPDATE folders SET drive_id = NULL WHERE drive_id = ${driveId}`;
            }
            yield* sql`UPDATE folders SET drive_id = ${driveId} WHERE id = ${folder.id}`;
            changedAnything = true;
          }
        }
        const name = input.name?.trim();
        if (name !== undefined && name !== folder.name) {
          yield* sql`UPDATE folders SET name = ${name} WHERE id = ${folder.id}`;
          changedAnything = true;
        }
        return changedAnything;
      }),
    ).pipe(
      traced("UserFolders.update", {
        "folder.id": input.id,
        "folder.change": [
          ...(input.name === undefined ? [] : ["name"]),
          ...(input.poolId === undefined ? [] : ["pool"]),
          ...(input.files === undefined ? [] : ["files"]),
        ].join(","),
      }),
    );

  const move: UserFolders["Service"]["move"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const moving = yield* requireFolder(current, input.id);
        yield* annotateOwner(moving.ownerId);
        if (input.parentId !== null) {
          const parent = yield* requireFolder(current, input.parentId);
          if (isWithin(current.tree, parent.id, moving.id)) {
            return yield* refuse("A folder can't go inside itself.");
          }
          if (parent.ownerId !== moving.ownerId) {
            return yield* refuse("A folder stays in its owner's folders.");
          }
        }
        const sameParent = moving.parentId === input.parentId;
        if (input.beforeId === input.id) {
          return sameParent ? false : yield* refuse("That position is not a sibling.");
        }
        const target = childIds(current.tree, moving.ownerId, input.parentId);
        const order = insertBefore(target, input.id, input.beforeId);
        if (order === undefined) return yield* refuse("That position is not a sibling.");
        if (sameParent && sameOrder(target, order)) return false;
        if (!sameParent) {
          yield* setOrder(
            moving.parentId,
            childIds(current.tree, moving.ownerId, moving.parentId).filter((id) => id !== input.id),
          );
        }
        yield* setOrder(input.parentId, order);
        return true;
      }),
    ).pipe(
      traced("UserFolders.move", { "folder.id": input.id, "folder.parent_id": input.parentId }),
    );

  const trash: UserFolders["Service"]["trash"] = (input) =>
    Effect.gen(function* () {
      const at = yield* owned;
      yield* foldNew(at.drives);
      const outcome = yield* sql.withTransaction(
        Effect.gen(function* () {
          const [stored] = yield* sql<{ readonly trash_id: string | null }>`
            SELECT trash_id FROM folders WHERE id = ${input.id}`;
          if (stored?.trash_id !== undefined && stored.trash_id !== null) {
            const existing = yield* readTrash(stored.trash_id);
            if (existing?.status === "trashed") {
              return { trash: existing, changed: false };
            }
          }

          const current = yield* load(at);
          const deleting = yield* requireFolder(current, input.id);
          yield* annotateOwner(deleting.ownerId);

          // Stop at a separately trashed child. It keeps its own receipt and deadline.
          const descendants = yield* sql<{
            readonly id: string;
          }>`WITH RECURSIVE subtree(id) AS (
              SELECT id FROM folders
              WHERE id = ${deleting.id} AND owner_id = ${deleting.ownerId} AND trash_id IS NULL
              UNION
              SELECT child.id FROM folders AS child JOIN subtree AS parent
                ON child.parent_id = parent.id
              WHERE child.owner_id = ${deleting.ownerId} AND child.trash_id IS NULL
            )
            SELECT id FROM subtree ORDER BY id`;
          const folderIds = descendants.map((row) => FolderId.make(row.id));
          if (folderIds.length === 0 || !folderIds.includes(deleting.id)) {
            return yield* refuse("That folder no longer exists.", "not-found");
          }

          const projectIds = current.tree.folders.flatMap((folder) =>
            folderIds.includes(folder.id) && folder.driveId !== null
              ? [projectIdForDrive(folder.driveId)]
              : [],
          );
          const filedThreads = yield* sql<{ readonly thread_id: string }>`SELECT homes.thread_id
            FROM thread_homes AS homes
            WHERE homes.folder_id IN ${sql.in(folderIds)}
              AND (EXISTS (SELECT 1 FROM thread_members AS members
                WHERE members.thread_id = homes.thread_id)
                OR EXISTS (SELECT 1 FROM thread_index AS indexed
                  WHERE indexed.thread_id = homes.thread_id))
              AND NOT EXISTS (SELECT 1 FROM thread_index AS foreign_thread
                WHERE foreign_thread.thread_id = homes.thread_id
                  AND foreign_thread.context_id != ${deleting.ownerId})
              AND NOT EXISTS (SELECT 1 FROM thread_index AS deleted
                WHERE deleted.thread_id = homes.thread_id
                  AND json_extract(deleted.shell, '$.deletedAt') IS NOT NULL)`;
          const projectThreads =
            projectIds.length === 0
              ? []
              : yield* sql<{ readonly thread_id: string }>`SELECT thread_id FROM thread_index
                  WHERE json_extract(shell, '$.projectId') IN ${sql.in(projectIds)}
                    AND context_id = ${deleting.ownerId}
                    AND NOT EXISTS (SELECT 1 FROM thread_homes AS filed
                      WHERE filed.thread_id = thread_index.thread_id)
                    AND json_extract(shell, '$.deletedAt') IS NULL`;
          const threadIds = [
            ...new Set([
              ...filedThreads.map((row) => row.thread_id),
              ...projectThreads.map((row) => row.thread_id),
            ]),
          ].map((threadId) => ThreadId.make(threadId));
          const driveIds = current.tree.folders.flatMap((folder) =>
            folderIds.includes(folder.id) && folder.driveId !== null ? [folder.driveId] : [],
          );
          const notes = yield* sql<{ readonly id: string }>`SELECT id FROM notes
            WHERE folder_id IN ${sql.in(folderIds)} ORDER BY id`;
          const noteIds = notes.map((row) => NoteId.make(row.id));
          const deletedAt = yield* Clock.currentTimeMillis;
          const trashId = yield* Effect.orDie(crypto.randomUUIDv4());
          const record: FolderTrashStore.Record = {
            trashId,
            folderId: deleting.id,
            ownerId: deleting.ownerId,
            title: deleting.name,
            parentId: deleting.parentId,
            position: deleting.position,
            folderIds,
            driveIds,
            threadIds,
            noteIds,
            deletedAt,
            restoreUntil: deletedAt + FolderTrashStore.RETENTION_MS,
            status: "trashed",
          };
          yield* sql`INSERT INTO folder_trash
              (trash_id, folder_id, owner_id, title, parent_id, position, folder_ids, drive_ids,
                thread_ids, note_ids, deleted_at, restore_until, status)
            VALUES (${record.trashId}, ${record.folderId}, ${record.ownerId}, ${record.title},
              ${record.parentId}, ${record.position}, ${encodeTrashFolderIds(record.folderIds)},
              ${encodeTrashDriveIds(record.driveIds)}, ${encodeTrashThreadIds(record.threadIds)},
              ${encodeTrashNoteIds(record.noteIds)},
              ${record.deletedAt}, ${record.restoreUntil}, 'trashed')`;
          yield* sql`UPDATE folders SET trash_id = ${trashId}, trashed_at = ${deletedAt}
            WHERE id IN ${sql.in(folderIds)} AND trash_id IS NULL`;
          // Keep sibling positions as anchors for restoring nested trashed children later.
          yield* bump;
          return { trash: record, changed: true };
        }),
      );
      if (outcome.changed) yield* PubSub.publish(changed, undefined);
      return { trash: outcome.trash, snapshot: toSnapshot(yield* load(at)) };
    }).pipe(traced("UserFolders.trash", { "folder.id": input.id }));

  const restoreTrash: UserFolders["Service"]["restoreTrash"] = (trashId, requestedAt) =>
    Effect.gen(function* () {
      const at = yield* owned;
      yield* foldNew(at.drives);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const record = yield* readTrash(trashId);
          if (record === null || record.status === "purged") {
            return yield* refuse("That folder is no longer in the trash.", "not-found");
          }
          if (record.status === "restored") return { trash: record, restored: false };
          const now = yield* Clock.currentTimeMillis;
          if ((requestedAt ?? now) >= record.restoreUntil) {
            return yield* refuse("That folder's restore period has ended.", "not-found");
          }
          const current = yield* load(at);
          if (record.parentId !== null) {
            const [parent] = yield* sql<{ readonly trash_id: string | null }>`SELECT trash_id
              FROM folders WHERE id = ${record.parentId}`;
            if (parent?.trash_id != null) {
              return yield* refuse("Restore the parent folder first.");
            }
            yield* requireFolder(current, record.parentId);
          }
          const [marked] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
            FROM folders WHERE trash_id = ${trashId}`;
          if ((marked?.count ?? 0) === 0) {
            return yield* refuse("That folder is no longer in the trash.", "not-found");
          }
          const siblings = childIds(current.tree, record.ownerId, record.parentId);
          const anchoredAt = siblings.findIndex(
            (id) =>
              (current.tree.folders.find((folder) => folder.id === id)?.position ?? -1) >=
              record.position,
          );
          const position = anchoredAt < 0 ? siblings.length : anchoredAt;
          const restoredSiblings = [
            ...siblings.slice(0, position),
            record.folderId,
            ...siblings.slice(position),
          ];
          yield* sql`UPDATE folders SET trash_id = NULL, trashed_at = NULL
            WHERE trash_id = ${trashId}`;
          yield* setOrder(record.parentId, restoredSiblings);
          yield* sql`UPDATE folder_trash SET status = 'restored'
            WHERE trash_id = ${trashId} AND status = 'trashed'`;
          yield* bump;
          return { trash: { ...record, status: "restored" as const }, restored: true };
        }),
      );
      if (result.restored) yield* PubSub.publish(changed, undefined);
      return { ...result, snapshot: toSnapshot(yield* load(at)) };
    }).pipe(traced("UserFolders.restoreTrash", { "trash.id": trashId }));

  const remove: UserFolders["Service"]["delete"] = (input) =>
    Effect.map(trash(input), (result) => result.snapshot).pipe(
      traced("UserFolders.delete", { "folder.id": input.id }),
    );

  const moveThread: UserFolders["Service"]["moveThread"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const target =
          input.folderId === null ? null : yield* requireFolder(current, input.folderId);
        const indexed = yield* indexedThread(input.threadId);
        const ownerId = target?.ownerId ?? indexed?.contextId;
        if (ownerId !== undefined) yield* annotateOwner(ownerId);
        const filed = current.tree.filed.get(input.threadId);
        if (
          filed !== undefined &&
          filed !== null &&
          !current.tree.folders.some((f) => f.id === filed)
        ) {
          const [stored] = yield* sql<{ readonly trash_id: string | null }>`
            SELECT trash_id FROM folders WHERE id = ${filed}`;
          if (stored?.trash_id != null) {
            return yield* refuse("That thread is in a folder in Trash. Restore it first.");
          }
        }
        if (target !== null && indexed !== null && target.ownerId !== indexed.contextId) {
          return yield* refuse("A thread stays in its owner's folders.");
        }
        const projectFolder =
          indexed === null ? undefined : folderOfProject(current.tree, indexed.projectId);
        // Back where its project would put it: no filing needed.
        if (projectFolder !== undefined && projectFolder === input.folderId) {
          if (filed === undefined) return false;
          yield* sql`DELETE FROM thread_homes WHERE thread_id = ${input.threadId}`;
          return true;
        }
        if (current.tree.filed.has(input.threadId) && filed === input.folderId) return false;
        const now = yield* Clock.currentTimeMillis;
        // A thread filed before it was created that never was: its filing goes.
        yield* sql`DELETE FROM thread_homes WHERE filed_at < ${now - UNCLAIMED_FILING_MS}
          AND thread_id NOT IN (SELECT thread_id FROM thread_index)
          AND thread_id NOT IN (SELECT thread_id FROM thread_members)`;
        yield* sql`INSERT INTO thread_homes (thread_id, folder_id, filed_at)
          VALUES (${input.threadId}, ${input.folderId}, ${now})
          ON CONFLICT (thread_id) DO UPDATE SET folder_id = excluded.folder_id,
            filed_at = excluded.filed_at`;
        return true;
      }),
    ).pipe(
      traced("UserFolders.moveThread", {
        "thread.id": input.threadId,
        "folder.id": input.folderId ?? "top",
      }),
    );

  const setInstructions: UserFolders["Service"]["setInstructions"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const text = input.instructions.trim() === "" ? null : input.instructions;
        if (input.level._tag === "top") {
          if (current.tree.topInstructions === text) return false;
          yield* sql`UPDATE folders_state SET instructions = ${text} WHERE id = 1`;
          return true;
        }
        const folder = yield* requireFolder(current, input.level.folderId);
        if (folder.instructions === text) return false;
        yield* sql`UPDATE folders SET instructions = ${text} WHERE id = ${folder.id}`;
        return true;
      }),
    ).pipe(
      traced("UserFolders.setInstructions", {
        "folder.id": input.level._tag === "top" ? "top" : input.level.folderId,
      }),
    );

  const setPhase: UserFolders["Service"]["setPhase"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const folder = yield* requireFolder(current, input.id);
        yield* annotateOwner(folder.ownerId);
        const next = nextPhase(folder.phase, input);
        if ("refused" in next) return yield* refuse(next.refused);
        if (samePhase(folder.phase, next.phase)) return false;
        const columns = columnsOfPhase(next.phase);
        yield* sql`UPDATE folders SET phases = ${columns.phases}, phase = ${columns.phase}
          WHERE id = ${folder.id}`;
        return true;
      }),
    ).pipe(
      // Never the phases' names: people name them.
      traced("UserFolders.setPhase", {
        "folder.id": input.id,
        "folder.change": [
          ...(input.phases === undefined ? [] : [input.phases === null ? "clear" : "list"]),
          ...(input.current === undefined ? [] : ["current"]),
        ].join(","),
      }),
    );

  const setSecrets: UserFolders["Service"]["setSecrets"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const environmentId = input.secrets?.environmentId ?? null;
        if (input.level._tag === "top") {
          if (current.tree.topSecrets === environmentId) return false;
          yield* sql`UPDATE folders_state SET secrets_environment_id = ${environmentId} WHERE id = 1`;
          return true;
        }
        const folder = yield* requireFolder(current, input.level.folderId);
        yield* annotateOwner(folder.ownerId);
        if (folder.secrets === environmentId) return false;
        yield* sql`UPDATE folders SET secrets_environment_id = ${environmentId}
          WHERE id = ${folder.id}`;
        return true;
      }),
    ).pipe(
      traced("UserFolders.setSecrets", {
        "folder.id": input.level._tag === "top" ? "top" : input.level.folderId,
        "secrets.set": String(input.secrets !== null),
      }),
    );

  /** Applies `change` in a transaction; when it changed anything, bumps and tells subscribers. */
  const changedWith = <E>(change: Effect.Effect<boolean, E>) =>
    Effect.gen(function* () {
      const changedAnything = yield* sql.withTransaction(
        Effect.tap(change, (did) => (did ? Effect.asVoid(bump) : Effect.void)),
      );
      if (changedAnything) yield* PubSub.publish(changed, undefined);
    });

  // Never annotated with the token: only whether one was connected.
  const setOnePassword: UserFolders["Service"]["setOnePassword"] = (input) =>
    // A failed write's cause names the statement, token included: it never reaches the span.
    changedWith(
      onePassword
        .set(input.token)
        .pipe(
          Effect.catchTags({ SqlError: () => refuse("Could not change your 1Password account.") }),
        ),
    ).pipe(
      Effect.andThen(snapshot),
      traced("UserFolders.setOnePassword", {
        "onepassword.connected": String(input.token !== null),
      }),
    );

  const adoptOnePassword: UserFolders["Service"]["adoptOnePassword"] = (token) =>
    changedWith(onePassword.adopt(token));

  const setGitHubLend: UserFolders["Service"]["setGitHubLend"] = (folderId, login) =>
    mutate((current) =>
      Effect.gen(function* () {
        const folder = yield* requireFolder(current, folderId);
        yield* annotateOwner(folder.ownerId);
        return yield* bindings.setGitHubLend(folder.id, login);
      }),
    ).pipe(
      traced("UserFolders.setGitHubLend", {
        "folder.id": folderId,
        "folder.change": login === null ? "github-lend-stop" : "github-lend",
      }),
    );

  const forgetPool: UserFolders["Service"]["forgetPool"] = (poolId) =>
    changedWith(bindings.forgetPool(poolId));

  const trashedFolderForDrive = (driveId: string) =>
    Effect.map(
      sql<{ readonly id: string }>`SELECT id FROM folders
        WHERE drive_id = ${driveId} AND trash_id IS NOT NULL LIMIT 1`,
      (rows) => (rows[0] === undefined ? null : FolderId.make(rows[0].id)),
    );

  const driveIsTrashed: UserFolders["Service"]["driveIsTrashed"] = (driveId) =>
    Effect.map(trashedFolderForDrive(driveId), (folderId) => folderId !== null);

  const trashedHome = (tree: Tree, threadId: ThreadId, projectId: ProjectId | null) =>
    Effect.gen(function* () {
      if (tree.filed.has(threadId)) {
        const filedHome = tree.filed.get(threadId);
        if (filedHome == null || tree.folders.some((folder) => folder.id === filedHome))
          return null;
        const [hidden] = yield* sql<{ readonly trash_id: string | null }>`SELECT trash_id
          FROM folders WHERE id = ${filedHome}`;
        return hidden?.trash_id == null ? null : filedHome;
      }
      if (projectId === null) return null;
      const driveId = tree.driveOfProject(projectId);
      return driveId === null ? null : yield* trashedFolderForDrive(driveId);
    });

  const trashedHomeOfThread: UserFolders["Service"]["trashedHomeOfThread"] = (threadId) =>
    Effect.gen(function* () {
      const at = yield* owned;
      const { tree } = yield* load(at, threadId);
      const indexed = yield* indexedThread(threadId);
      return yield* trashedHome(tree, threadId, indexed?.projectId ?? null);
    }).pipe(traced("UserFolders.trashedHomeOfThread", { "thread.id": threadId }));

  const turn: UserFolders["Service"]["turn"] = (thread) =>
    Effect.gen(function* () {
      const at = yield* owned;
      const { tree } = yield* load(at, thread.threadId);
      const filed = tree.filed.has(thread.threadId);
      const indexed = thread.projectId === null ? yield* indexedThread(thread.threadId) : null;
      const projectId = thread.projectId ?? indexed?.projectId ?? null;
      const hiddenHome = yield* trashedHome(tree, thread.threadId, projectId);
      if (hiddenHome !== null) {
        return yield* new ThreadHomeTrashedError({ folderId: hiddenHome });
      }
      const resolve = poolResolver(tree);
      const cascades = new Map<FolderId | null, TurnInstructions["top"]>();
      const cascadeOf = (home: FolderId | null) => {
        if (!cascades.has(home)) cascades.set(home, instructionsOf(tree, home));
        return cascades.get(home)!;
      };
      const secretChains = new Map<FolderId | null, TurnSecrets["top"]>();
      const secretsAt = (home: FolderId | null) => {
        if (!secretChains.has(home)) secretChains.set(home, secretsOf(tree, home));
        return secretChains.get(home)!;
      };
      const projectHomes = currentProjectIds(at.contexts).map(
        (projectId) => [projectId, folderOfProject(tree, projectId)] as const,
      );
      const ownerId =
        indexed?.contextId ??
        (projectId === null ? null : contextOfProject(at.contexts, projectId));
      const home = filed ? homeOf(tree, { threadId: thread.threadId, projectId, ownerId }) : null;
      const pools: TurnPools = {
        top: resolve(null)?.poolId ?? null,
        projects: Object.fromEntries(
          projectHomes.map(([id, folder]) => [id, resolve(folder)?.poolId ?? null]),
        ),
        ...(filed ? { thread: resolve(home)?.poolId ?? null } : {}),
      };
      const instructions: TurnInstructions = {
        top: cascadeOf(null),
        projects: Object.fromEntries(projectHomes.map(([id, folder]) => [id, cascadeOf(folder)])),
        ...(filed ? { thread: cascadeOf(home) } : {}),
      };
      const secrets: TurnSecrets = {
        top: secretsAt(null),
        projects: Object.fromEntries(projectHomes.map(([id, folder]) => [id, secretsAt(folder)])),
        ...(filed ? { thread: secretsAt(home) } : {}),
      };
      const own =
        filed || projectId === null
          ? home
          : (projectHomes.find(([id]) => id === projectId)?.[1] ?? null);
      yield* Effect.annotateCurrentSpan({
        ...(ownerId === null ? {} : { "org.id": ownerId }),
        "folder.id": own ?? "top",
        "folder.filed": filed,
        "instructions.levels": cascadeOf(own).length,
        "instructions.bytes": cascadeOf(own).reduce(
          (bytes, level) => bytes + new TextEncoder().encode(level.text).byteLength,
          0,
        ),
        // A count only: Environment ids name the user's vaults' contents.
        "secrets.levels": secretsAt(own).length,
      });
      return { pools, instructions, secrets };
    }).pipe(traced("UserFolders.turn", { "thread.id": thread.threadId }));

  const rows: UserFolders["Service"]["rows"] = Effect.gen(function* () {
    const [folderState] = decodeState(yield* selectState);
    const folders = decodeFolderRows(yield* selectFolders);
    const activeIds = new Set(folders.map((folder) => folder.id));
    return {
      folders,
      bindings: (yield* bindings.rows).filter(
        (binding) => binding.level_kind === "top" || activeIds.has(FolderId.make(binding.level_id)),
      ),
      topInstructions: folderState?.instructions ?? null,
      topSecrets: folderState?.secrets_environment_id ?? null,
    };
  });

  /**
   * Adds `input` in one transaction, never over what's here, with any
   * placements from before folders; drives aren't taken along, so a folder's
   * files arrive with its drive, if ever.
   */
  const adoptRows = (
    input: FolderRows,
    placements: ReadonlyArray<SectionRows["placements"][number]> = [],
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const row of input.folders) {
            yield* sql`INSERT INTO folders (id, owner_id, parent_id, name, position, instructions,
                secrets_environment_id, phases, phase, origin)
              VALUES (${row.id}, ${row.owner_id}, ${row.parent_id}, ${row.name}, ${row.position},
                ${row.instructions}, ${row.secrets_environment_id ?? null}, ${row.phases ?? null},
                ${row.phase ?? null}, ${row.origin == null ? null : encodeOrigin(row.origin)})
              ON CONFLICT (id) DO NOTHING`;
          }
          // A drive's folder takes its place from these the first time it's made.
          for (const row of placements) {
            yield* sql`INSERT INTO project_placements (project_id, section_id, position)
              VALUES (${row.project_id}, ${row.section_id}, ${row.position})
              ON CONFLICT (project_id) DO NOTHING`;
          }
          yield* bindings.adopt(input.bindings);
          if (input.topInstructions !== null) {
            yield* sql`UPDATE folders_state SET instructions = ${input.topInstructions}
              WHERE id = 1 AND instructions IS NULL`;
          }
          if (input.topSecrets != null) {
            yield* sql`UPDATE folders_state SET secrets_environment_id = ${input.topSecrets}
              WHERE id = 1 AND secrets_environment_id IS NULL`;
          }
          yield* bump;
        }),
      )
      .pipe(Effect.andThen(PubSub.publish(changed, undefined)), Effect.asVoid);

  const adopt: UserFolders["Service"]["adopt"] = (input) => adoptRows(input);

  const legacyRows: UserFolders["Service"]["legacyRows"] = Effect.all({
    folders: Effect.map(selectFolders, decodeFolderRows),
    sections: sql`SELECT id, context_id, parent_id, name, position FROM sections`.pipe(
      Effect.map(decodeSectionRows),
    ),
    placements: sql`SELECT project_id, section_id, position FROM project_placements`.pipe(
      Effect.map(decodePlacementRows),
    ),
    bindings: bindings.rows,
  }).pipe(
    Effect.map(({ folders, sections, placements, bindings: allBindings }) => {
      const activeIds = new Set(folders.map((folder) => folder.id));
      return {
        sections: sections.filter((section) => activeIds.has(FolderId.make(section.id))),
        placements: placements.filter(
          (placement) =>
            placement.section_id === null || activeIds.has(FolderId.make(placement.section_id)),
        ),
        bindings: allBindings.filter(
          (binding) =>
            binding.level_kind === "top" || activeIds.has(FolderId.make(binding.level_id)),
        ),
      };
    }),
  );

  const adoptLegacy: UserFolders["Service"]["adoptLegacy"] = (input) =>
    adoptRows(
      {
        folders: input.sections.map((row): FolderRow => ({
          id: FolderId.make(row.id),
          owner_id: SignalboxContextId.make(row.context_id),
          parent_id: row.parent_id === null ? null : FolderId.make(row.parent_id),
          name: row.name,
          position: row.position,
          drive_id: null,
          instructions: null,
        })),
        bindings: input.bindings ?? [],
        topInstructions: null,
      },
      input.placements,
    );

  const changes: UserFolders["Service"]["changes"] = Stream.map(states, toSnapshot);

  return UserFolders.of({
    states,
    legacyRows,
    adoptLegacy,
    state,
    snapshot,
    threadHome,
    changes,
    create,
    reserveStart,
    createFrom,
    update,
    move,
    delete: remove,
    trash,
    restoreTrash,
    trashDetails,
    restorePreflight,
    activeTrashes,
    moveThread,
    setInstructions,
    setPhase,
    setSecrets,
    setOnePassword,
    setGitHubLend,
    adoptOnePassword,
    forgetPool,
    driveIsTrashed,
    trashedHomeOfThread,
    turn,
    rows,
    adopt,
  });
});

export const layer = Layer.effect(UserFolders, make);
