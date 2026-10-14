import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FolderCreateInput,
  type FolderDeleteInput,
  FolderId,
  type FolderMoveInput,
  type FolderMoveThreadInput,
  type FolderSetInstructionsInput,
  type FolderUpdateInput,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";
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
import type { TurnInstructions, TurnPools } from "../thread/turnPool.ts";
import { contextOfProject, driveOfProject, projectIdForDrive } from "./contextProjects.ts";
import { foldDrives } from "./driveFolders.ts";
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
import { makeProfileId } from "./profileId.ts";
import * as ResourceBindings from "./ResourceBindings.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";

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

type Failure = FolderRefusedError | SqlError;

/** Everything a change is decided from. */
export interface FolderState {
  readonly contexts: ReadonlyArray<SignalboxContext>;
  /** Drives others gave the user, in their current owners' trees. */
  readonly drives: ReadonlyArray<UserDriveIndex.IndexedDrive>;
  readonly tree: Tree;
  readonly revision: number;
}

export class UserFolders extends Context.Service<
  UserFolders,
  {
    readonly state: Effect.Effect<FolderState, SqlError>;
    /** The state now, then again after every change, owners' and drives' included. */
    readonly states: Stream.Stream<FolderState, SqlError>;
    readonly snapshot: Effect.Effect<SignalboxFoldersSnapshot, SqlError>;
    /** `states` as snapshots. */
    readonly changes: Stream.Stream<SignalboxFoldersSnapshot, SqlError>;
    readonly create: (input: FolderCreateInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly update: (input: FolderUpdateInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly move: (input: FolderMoveInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly delete: (input: FolderDeleteInput) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly moveThread: (
      input: FolderMoveThreadInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, Failure>;
    readonly setInstructions: (
      input: FolderSetInstructionsInput,
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
      { readonly pools: TurnPools; readonly instructions: TurnInstructions },
      SqlError
    >;
    /** Every row as stored, owners left included: what a preview takes along (`previewSetup/`). */
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
    Schema.Struct({ revision: Schema.Number, instructions: Schema.NullOr(Schema.String) }),
  ),
);
const toTreeFolder = (row: typeof FolderRow.Type): TreeFolder => ({
  id: row.id,
  ownerId: row.owner_id,
  parentId: row.parent_id,
  name: row.name,
  position: row.position,
  driveId: row.drive_id,
  instructions: row.instructions,
});

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
  // Own changes and owner or drive changes share one signal, so a subscriber
  // that subscribes before its first read misses neither.
  const changed = yield* PubSub.sliding<void>(1);
  yield* contexts.contextsChanged.pipe(
    Stream.runForEach(() => PubSub.publish(changed, undefined)),
    Effect.forkScoped,
  );

  const bump = sql`UPDATE folders_state SET revision = revision + 1 WHERE id = 1`;

  /**
   * A span for one operation, with who did it and what it touched (#284):
   * ids only, never a folder's name or instructions. Its duration is the
   * operation's latency.
   */
  const traced =
    (name: string, attributes: Readonly<Record<string, string | null | undefined>>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(userId.pipe(Effect.orElseSucceed(() => null)), (person) =>
        effect.pipe(
          Effect.withSpan(name, {
            attributes: Object.fromEntries(
              Object.entries({ "person.id": person, ...attributes }).filter(
                ([, value]) => value !== null && value !== undefined,
              ),
            ),
          }),
        ),
      );
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
      const folders = decodeFolderRows(
        yield* sql`SELECT id, owner_id, parent_id, name, position, drive_id, instructions FROM folders`,
      )
        .filter((row) => at.owners.has(row.owner_id))
        .map(toTreeFolder);
      const homes = decodeHomeRows(
        filedOnly === undefined
          ? yield* sql`SELECT thread_id, folder_id FROM thread_homes`
          : yield* sql`SELECT thread_id, folder_id FROM thread_homes WHERE thread_id = ${filedOnly}`,
      );
      const [state] = decodeState(yield* sql`SELECT revision, instructions FROM folders_state`);
      const tree: Tree = {
        folders: withSoundParents(folders),
        topInstructions: state?.instructions ?? null,
        bindings: yield* bindings.pools,
        filed: new Map(homes.map((row) => [row.thread_id, row.folder_id])),
        driveOfProject: (projectId) => (user === null ? null : driveOfProject(projectId, user)),
      };
      return {
        contexts: at.contexts,
        drives: at.drives,
        tree,
        revision: state?.revision ?? 0,
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
      const id = FolderId.make(yield* Effect.orDie(crypto.randomUUIDv4));
      return yield* mutate((current) =>
        Effect.gen(function* () {
          const parent =
            input.parentId === null ? null : yield* requireFolder(current, input.parentId);
          const ownerId = parent?.ownerId ?? input.ownerId ?? PERSONAL_CONTEXT_ID;
          yield* annotateOwner(ownerId);
          if (!current.contexts.some((context) => context.id === ownerId)) {
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
          yield* sql`INSERT INTO folders (id, owner_id, parent_id, name, position)
            VALUES (${id}, ${ownerId}, ${input.parentId}, ${input.name.trim()}, 0)`;
          yield* setOrder(input.parentId, order);
          return true;
        }),
      );
    }).pipe(traced("UserFolders.create", { "folder.parent_id": input.parentId }));

  /** The drive `projectId` names, when it can be a folder's files: given to the user, in `ownerId`'s tree. */
  const filesFor = (current: FolderState, projectId: ProjectId, ownerId: string) => {
    const drive = current.drives.find(
      (candidate) => projectIdForDrive(candidate.driveId) === projectId,
    );
    if (drive === undefined) {
      return refuse(
        "Choose a shared drive or a shared folder. Your own files stay at the top level.",
      );
    }
    if (parseDriveId(drive.driveId)?.contextId !== ownerId) {
      return refuse("Those files belong to another owner's folders.");
    }
    return Effect.succeed(drive.driveId);
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
            if (driveId !== null) {
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

  const remove: UserFolders["Service"]["delete"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const deleting = yield* requireFolder(current, input.id);
        const { ownerId, parentId } = deleting;
        yield* annotateOwner(ownerId);
        // Its folders take its place; its threads go up to its parent.
        const siblings = childIds(current.tree, ownerId, parentId);
        const at = Math.max(0, siblings.indexOf(input.id));
        const others = siblings.filter((id) => id !== input.id);
        yield* setOrder(parentId, [
          ...others.slice(0, at),
          ...childIds(current.tree, ownerId, input.id),
          ...others.slice(at),
        ]);
        const now = yield* Clock.currentTimeMillis;
        if (deleting.driveId !== null) {
          // Its files' threads lived here without being filed: file them where the rest go.
          yield* sql`INSERT INTO thread_homes (thread_id, folder_id, filed_at)
            SELECT thread_id, ${parentId}, ${now} FROM thread_index
            WHERE json_extract(shell, '$.projectId') = ${projectIdForDrive(deleting.driveId)}
            ON CONFLICT (thread_id) DO NOTHING`;
        }
        yield* sql`UPDATE thread_homes SET folder_id = ${parentId}, filed_at = ${now}
          WHERE folder_id = ${input.id}`;
        yield* sql`DELETE FROM folders WHERE id = ${input.id}`;
        yield* bindings.setPool(levelOf(input.id), null);
        return true;
      }),
    ).pipe(traced("UserFolders.delete", { "folder.id": input.id }));

  const moveThread: UserFolders["Service"]["moveThread"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const target =
          input.folderId === null ? null : yield* requireFolder(current, input.folderId);
        const indexed = yield* indexedThread(input.threadId);
        const ownerId = target?.ownerId ?? indexed?.contextId;
        if (ownerId !== undefined) yield* annotateOwner(ownerId);
        if (target !== null && indexed !== null && target.ownerId !== indexed.contextId) {
          return yield* refuse("A thread stays in its owner's folders.");
        }
        const projectFolder =
          indexed === null ? undefined : folderOfProject(current.tree, indexed.projectId);
        const filed = current.tree.filed.get(input.threadId);
        // Back where its project would put it: no filing needed.
        if (projectFolder !== undefined && projectFolder === input.folderId) {
          if (filed === undefined) return false;
          yield* sql`DELETE FROM thread_homes WHERE thread_id = ${input.threadId}`;
          return true;
        }
        if (current.tree.filed.has(input.threadId) && filed === input.folderId) return false;
        const now = yield* Clock.currentTimeMillis;
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

  const forgetPool: UserFolders["Service"]["forgetPool"] = (poolId) =>
    Effect.gen(function* () {
      const forgotten = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* bindings.forgetPool(poolId))) return false;
          yield* bump;
          return true;
        }),
      );
      if (forgotten) yield* PubSub.publish(changed, undefined);
    });

  const turn: UserFolders["Service"]["turn"] = (thread) =>
    Effect.gen(function* () {
      const at = yield* owned;
      const { tree } = yield* load(at, thread.threadId);
      const resolve = poolResolver(tree);
      const cascades = new Map<FolderId | null, TurnInstructions["top"]>();
      const cascadeOf = (home: FolderId | null) => {
        if (!cascades.has(home)) cascades.set(home, instructionsOf(tree, home));
        return cascades.get(home)!;
      };
      const projectHomes = currentProjectIds(at.contexts).map(
        (projectId) => [projectId, folderOfProject(tree, projectId)] as const,
      );
      // Only a filed thread differs from its project's home; it's the one to check.
      const filed = tree.filed.has(thread.threadId);
      const indexed =
        filed && thread.projectId === null ? yield* indexedThread(thread.threadId) : null;
      const projectId = thread.projectId ?? indexed?.projectId ?? null;
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
      });
      return { pools, instructions };
    }).pipe(traced("UserFolders.turn", { "thread.id": thread.threadId }));

  const rows: UserFolders["Service"]["rows"] = Effect.gen(function* () {
    const [folderState] = decodeState(yield* sql`SELECT revision, instructions FROM folders_state`);
    return {
      folders: decodeFolderRows(
        yield* sql`SELECT id, owner_id, parent_id, name, position, drive_id, instructions FROM folders`,
      ),
      bindings: yield* bindings.rows,
      topInstructions: folderState?.instructions ?? null,
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
            yield* sql`INSERT INTO folders (id, owner_id, parent_id, name, position, instructions)
              VALUES (${row.id}, ${row.owner_id}, ${row.parent_id}, ${row.name}, ${row.position},
                ${row.instructions})
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
          yield* bump;
        }),
      )
      .pipe(Effect.andThen(PubSub.publish(changed, undefined)), Effect.asVoid);

  const adopt: UserFolders["Service"]["adopt"] = (input) => adoptRows(input);

  const legacyRows: UserFolders["Service"]["legacyRows"] = Effect.all({
    sections: sql`SELECT id, context_id, parent_id, name, position FROM sections`.pipe(
      Effect.map(decodeSectionRows),
    ),
    placements: sql`SELECT project_id, section_id, position FROM project_placements`.pipe(
      Effect.map(decodePlacementRows),
    ),
    bindings: bindings.rows,
  });

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
    changes,
    create,
    update,
    move,
    delete: remove,
    moveThread,
    setInstructions,
    forgetPool,
    turn,
    rows,
    adopt,
  });
});

export const layer = Layer.effect(UserFolders, make);
