import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import {
  type NoteAcceptResult,
  type NoteCreateInput,
  NoteId,
  type NoteIdInput,
  type NoteUpdateInput,
  type NoteVisibility,
  readerOf,
  type SignalboxNotesSnapshot,
} from "@t3tools/contracts/signalboxNotes";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { poolObjectName } from "../pool/PoolDirectory.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import { poolResolver, type TreeFolder } from "../user/folderTree.ts";
import { makeProfileId } from "../user/profileId.ts";
import { makeTraced } from "../user/tracing.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserFolders from "../user/UserFolders.ts";
import { NoteReader } from "./NoteReader.ts";
import { CONTEXT_NOTES } from "./noteReading.ts";
import { type AgentNote, agentNotes, chainFolderIds } from "./agentNotes.ts";
import { decodeNoteRows, encodeReading, type NoteRow, offerOf, toNote } from "./noteRows.ts";
import { noteTask } from "./noteTask.ts";

/**
 * The user's notes (#318), in their own object: half-formed thoughts with a
 * home (a folder, or the top level) and no status, so they never enter the
 * pipeline. Private by default; a note in an organization's folder may be
 * shared with its team.
 *
 * After a note is written or changed, it's read in the background
 * (`NoteReader`) by whoever reads it at its level: the author's assistant
 * for a private note, the folder's agent for a team one. The change answers
 * at once; the reading lands as a later change, and only if the note still
 * says what was read. Accepting an offer starts a task in the note's home
 * with the note's own words first.
 */

/** Why a change was refused, for the user. */
export class NoteRefusedError extends Schema.TaggedError<NoteRefusedError>()("NoteRefusedError", {
  message: Schema.String,
}) {}

type Failure = NoteRefusedError | SqlError;

export class UserNotes extends Context.Service<
  UserNotes,
  {
    readonly snapshot: Effect.Effect<SignalboxNotesSnapshot, SqlError>;
    /** The snapshot now, then again after every change to the notes or the folders they're in. */
    readonly changes: Stream.Stream<SignalboxNotesSnapshot, SqlError>;
    readonly create: (input: NoteCreateInput) => Effect.Effect<SignalboxNotesSnapshot, Failure>;
    readonly update: (input: NoteUpdateInput) => Effect.Effect<SignalboxNotesSnapshot, Failure>;
    readonly delete: (input: NoteIdInput) => Effect.Effect<SignalboxNotesSnapshot, Failure>;
    readonly readAgain: (input: NoteIdInput) => Effect.Effect<SignalboxNotesSnapshot, Failure>;
    readonly dismissReading: (input: NoteIdInput) => Effect.Effect<SignalboxNotesSnapshot, Failure>;
    /** Starts the offer as a task on `modelSelection`, in the note's home. */
    readonly accept: (input: {
      readonly id: NoteId;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<NoteAcceptResult, Failure>;
    /**
     * The team notes on `threadId`'s home chain still on their pads, newest
     * first: its home folder and the folders above it. Never a private note.
     */
    readonly listForAgent: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<AgentNote>, SqlError>;
  }
>()("@signalbox/cloud/notes/UserNotes") {}

const decodeRevision = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ revision: Schema.Number })),
);
const decodeContext = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ text: Schema.String, created_at: Schema.Number })),
);

/** The folders whose notes the user sees: those of their current owners. */
type VisibleFolders = ReadonlySet<FolderId>;

const visibleFoldersOf = (current: UserFolders.FolderState): VisibleFolders =>
  new Set(current.tree.folders.map((folder) => folder.id));

const sameFolders = (left: VisibleFolders, right: VisibleFolders) =>
  left.size === right.size && [...left].every((id) => right.has(id));

/** Every change bumps the revision, so the same revision and notes is the same snapshot. */
const sameSnapshot = (left: SignalboxNotesSnapshot, right: SignalboxNotesSnapshot) =>
  left.revision === right.revision &&
  left.notes.length === right.notes.length &&
  left.notes.every((note, index) => note.id === right.notes[index]!.id);

const refuse = (message: string) => Effect.fail(new NoteRefusedError({ message }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const folders = yield* UserFolders.UserFolders;
  const reader = yield* NoteReader;
  const threads = yield* CloudThreadService.CloudThreadService;
  const drives = yield* UserDrives.UserDrives;
  const userId = yield* makeProfileId;
  const changed = yield* PubSub.sliding<void>(1);
  // Reads outlive the call that started them; a newer read of a note replaces its older one.
  const reads = yield* FiberMap.make<NoteId>();
  // One accept at a time, so two clicks can't start two tasks.
  const accepting = yield* Semaphore.make(1);

  /** A span for one operation (`tracing.ts`): never a note's words or its reading. */
  const traced = makeTraced(userId);

  const bump = sql`UPDATE notes_state SET revision = revision + 1 WHERE id = 1`;
  const selectNotes = sql`SELECT id, folder_id, author_id, visibility, text, created_at, reading,
    accepted_thread_id FROM notes ORDER BY created_at DESC, id DESC`;
  const rowOf = (id: NoteId) =>
    Effect.map(
      sql`SELECT id, folder_id, author_id, visibility, text, created_at, reading,
        accepted_thread_id FROM notes WHERE id = ${id}`,
      (rows) => decodeNoteRows(rows)[0] ?? null,
    );

  /** Notes on the user's current levels: those in folders of owners they left stay out of sight. */
  const snapshotIn = (folderIds: VisibleFolders) =>
    Effect.gen(function* () {
      const [state] = decodeRevision(yield* sql`SELECT revision FROM notes_state`);
      const rows = decodeNoteRows(yield* selectNotes);
      return {
        revision: state?.revision ?? 0,
        notes: rows
          .filter((row) => row.folder_id === null || folderIds.has(row.folder_id))
          .map(toNote),
      } satisfies SignalboxNotesSnapshot;
    });
  const snapshotWith = (current: UserFolders.FolderState) => snapshotIn(visibleFoldersOf(current));

  const snapshot: UserNotes["Service"]["snapshot"] = Effect.flatMap(folders.state, snapshotWith);

  // One folder-state read per folder change, however many subscribers and reads
  // watch it; a change that leaves the visible folders as they were (a filed
  // thread, a rename) goes no further.
  const visibleFolders = yield* folders.states.pipe(
    Stream.map(visibleFoldersOf),
    Stream.changesWith(sameFolders),
    Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }),
  );

  // The notes' own signal is subscribed before the first snapshot is read, so
  // no change falls between. One snapshot per change, shared by every subscriber.
  const changes: UserNotes["Service"]["changes"] = yield* Stream.zipLatest(
    visibleFolders,
    Stream.unwrap(
      Effect.map(PubSub.subscribe(changed), (subscription) =>
        Stream.fromSubscription(subscription).pipe(Stream.prepend([undefined])),
      ),
    ),
  ).pipe(
    Stream.mapEffect(([folderIds]) => snapshotIn(folderIds)),
    Stream.changesWith(sameSnapshot),
    Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }),
  );

  /** Waits until `folderId` is no longer one of the user's: deleted, or its owner left. */
  const folderGone = (folderId: FolderId) =>
    visibleFolders.pipe(
      Stream.filter((folderIds) => !folderIds.has(folderId)),
      Stream.runHead,
      Effect.asVoid,
      // A folder read failing is no reason to stop a note's read.
      Effect.catch(() => Effect.never),
    );

  /** Applies `change` in a transaction; when it changed anything, bumps and tells subscribers. */
  const changedWith = <E>(change: Effect.Effect<boolean, E>) =>
    Effect.gen(function* () {
      const did = yield* sql.withTransaction(
        Effect.tap(change, (changedAnything) =>
          changedAnything ? Effect.asVoid(bump) : Effect.void,
        ),
      );
      if (did) yield* PubSub.publish(changed, undefined);
      return did;
    });

  const requireNote = (id: NoteId) =>
    rowOf(id).pipe(
      Effect.filterOrElse(
        (row): row is NoteRow => row !== null,
        () => refuse("That note no longer exists."),
      ),
    );

  /** The folder a note lives in, when it's one of the user's current folders; null is the top level. */
  const folderOf = (current: UserFolders.FolderState, folderId: FolderId | null) => {
    if (folderId === null) return Effect.succeed(null);
    const folder = current.tree.folders.find((candidate) => candidate.id === folderId);
    return folder === undefined ? refuse("That folder no longer exists.") : Effect.succeed(folder);
  };

  /** A team note needs a team: an organization's folder. */
  const checkVisibility = (folder: TreeFolder | null, visibility: NoteVisibility) =>
    visibility === "private"
      ? Effect.void
      : folder === null
        ? refuse("Notes at the top level stay private.")
        : folder.ownerId === PERSONAL_CONTEXT_ID
          ? refuse("Only notes in an organization's folders can be shared with its team.")
          : Effect.void;

  /**
   * The other notes on `row`'s pad its reader may see, newest first: a team
   * read sees only the team's. Same folder, so as visible as `row` itself.
   */
  const contextOf = (row: NoteRow) =>
    Effect.map(
      sql`SELECT text, created_at FROM notes
        WHERE folder_id IS ${row.folder_id} AND id != ${row.id} AND accepted_thread_id IS NULL
          AND (${row.visibility} = 'private' OR visibility = 'team')
        ORDER BY created_at DESC, id DESC LIMIT ${CONTEXT_NOTES}`,
      (rows) =>
        decodeContext(rows).map((other) => ({ text: other.text, createdAt: other.created_at })),
    );

  /**
   * Reads `row` in the background, replacing any read of it still running,
   * and stopping it if its folder goes (its notes move up). The reading is
   * written only if the note still exists, is in the same place, says the
   * same and has the same reader, and hasn't become a task.
   */
  const readInBackground = (row: NoteRow, current: UserFolders.FolderState) =>
    Effect.gen(function* () {
      const user = yield* userId;
      const folder = row.folder_id === null ? null : yield* folderOf(current, row.folder_id);
      const poolId = poolResolver(current.tree)(row.folder_id)?.poolId ?? null;
      const read = Effect.gen(function* () {
        const context = yield* contextOf(row);
        yield* Effect.annotateCurrentSpan("note.context", context.length);
        const reading = yield* reader.read({
          reader: readerOf(row.visibility),
          folderName: folder?.name ?? null,
          text: row.text,
          context,
          now: yield* Clock.currentTimeMillis,
          pool:
            user === null || poolId === null
              ? null
              : { objectName: poolObjectName(user, poolId), userId: user },
        });
        if (Option.isNone(reading)) return;
        const json = encodeReading(reading.value);
        yield* changedWith(
          Effect.map(
            sql`UPDATE notes SET reading = ${json}
              WHERE id = ${row.id} AND folder_id IS ${row.folder_id} AND text = ${row.text}
                AND visibility = ${row.visibility} AND accepted_thread_id IS NULL
              RETURNING id`,
            (rows) => rows.length > 0,
          ),
        );
      }).pipe(
        (reading) =>
          row.folder_id === null ? reading : Effect.raceFirst(reading, folderGone(row.folder_id)),
        Effect.catchCause((cause) => Effect.logError("reading a note failed", { cause })),
        traced("UserNotes.read", {
          "note.id": row.id,
          "folder.id": row.folder_id ?? "top",
          "note.visibility": row.visibility,
          "note.length": row.text.length,
          "pool.id": poolId,
        }),
      );
      yield* FiberMap.run(reads, row.id, read);
    }).pipe(Effect.catchTags({ NoteRefusedError: () => Effect.void }));

  const create: UserNotes["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const author = yield* userId;
      if (author === null) return yield* refuse("Sign in again to write notes.");
      const id = NoteId.make(yield* Effect.orDie(crypto.randomUUIDv4()));
      const current = yield* folders.state;
      const folderId = input.home._tag === "top" ? null : input.home.folderId;
      const folder = yield* folderOf(current, folderId);
      const visibility = input.visibility ?? "private";
      yield* checkVisibility(folder, visibility);
      const now = yield* Clock.currentTimeMillis;
      yield* changedWith(
        Effect.as(
          sql`INSERT INTO notes (id, folder_id, author_id, visibility, text, created_at)
            VALUES (${id}, ${folderId}, ${author}, ${visibility}, ${input.text}, ${now})`,
          true,
        ),
      );
      yield* Effect.annotateCurrentSpan({ "note.id": id, "note.length": input.text.length });
      yield* readInBackground(
        {
          id,
          folder_id: folderId,
          author_id: author,
          visibility,
          text: input.text,
          created_at: now,
          reading: null,
          accepted_thread_id: null,
        },
        current,
      );
      return yield* snapshotWith(current);
    }).pipe(
      traced("UserNotes.create", {
        "folder.id": input.home._tag === "top" ? "top" : input.home.folderId,
        "note.visibility": input.visibility ?? "private",
      }),
    );

  /** An accepted note is a task now: it changes no more. */
  const requireOnPad = (row: NoteRow) =>
    row.accepted_thread_id === null ? Effect.void : refuse("That note is already a task.");

  const update: UserNotes["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const row = yield* requireNote(input.id);
      yield* requireOnPad(row);
      const current = yield* folders.state;
      const text = input.text ?? row.text;
      const visibility = input.visibility ?? row.visibility;
      if (text === row.text && visibility === row.visibility) return yield* snapshotWith(current);
      yield* checkVisibility(yield* folderOf(current, row.folder_id), visibility);
      // New words or a new reader: what was made of the old ones no longer holds.
      yield* changedWith(
        Effect.as(
          sql`UPDATE notes SET text = ${text}, visibility = ${visibility}, reading = NULL
            WHERE id = ${row.id}`,
          true,
        ),
      );
      yield* readInBackground({ ...row, text, visibility, reading: null }, current);
      return yield* snapshotWith(current);
    }).pipe(
      traced("UserNotes.update", {
        "note.id": input.id,
        "note.change": [
          ...(input.text === undefined ? [] : ["text"]),
          ...(input.visibility === undefined ? [] : ["visibility"]),
        ].join(","),
      }),
    );

  const remove: UserNotes["Service"]["delete"] = (input) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(reads, input.id);
      yield* changedWith(
        Effect.map(
          sql`DELETE FROM notes WHERE id = ${input.id} RETURNING id`,
          (rows) => rows.length > 0,
        ),
      );
      return yield* snapshot;
    }).pipe(traced("UserNotes.delete", { "note.id": input.id }));

  const readAgain: UserNotes["Service"]["readAgain"] = (input) =>
    Effect.gen(function* () {
      const row = yield* requireNote(input.id);
      yield* requireOnPad(row);
      const current = yield* folders.state;
      yield* changedWith(
        Effect.map(
          sql`UPDATE notes SET reading = NULL WHERE id = ${row.id} AND reading IS NOT NULL
            RETURNING id`,
          (rows) => rows.length > 0,
        ),
      );
      yield* readInBackground({ ...row, reading: null }, current);
      return yield* snapshotWith(current);
    }).pipe(traced("UserNotes.readAgain", { "note.id": input.id }));

  const dismissReading: UserNotes["Service"]["dismissReading"] = (input) =>
    Effect.gen(function* () {
      const row = yield* requireNote(input.id);
      const offer = offerOf(row);
      if (offer !== null) {
        // Only the offer read here: a newer reading, or none, isn't dismissed in its place.
        yield* changedWith(
          Effect.map(
            sql`UPDATE notes SET reading = ${encodeReading({ ...offer, dismissed: true })}
              WHERE id = ${row.id} AND reading = ${encodeReading(offer)}
                AND accepted_thread_id IS NULL
              RETURNING id`,
            (rows) => rows.length > 0,
          ),
        );
      }
      return yield* snapshot;
    }).pipe(traced("UserNotes.dismissReading", { "note.id": input.id }));

  /** What a thread call's failure tells the user; an unavailable thread is logged. */
  const launchRefusal = (error: CloudThreadService.CloudThreadError) =>
    error._tag === "ThreadCommandRejectedError"
      ? refuse(error.reason)
      : Effect.logError("starting a note's task failed", { cause: error }).pipe(
          Effect.andThen(refuse("Could not start the task right now. Try again.")),
        );

  const accept: UserNotes["Service"]["accept"] = (input) =>
    Effect.gen(function* () {
      const row = yield* requireNote(input.id);
      yield* requireOnPad(row);
      const offer = offerOf(row);
      if (offer === null) return yield* refuse("That note has no offer to accept.");
      const user = yield* userId;
      if (user === null) return yield* refuse("Sign in again to start tasks.");
      const current = yield* folders.state;
      const folder = yield* folderOf(current, row.folder_id);
      yield* Effect.annotateCurrentSpan("folder.id", folder?.id ?? "top");
      const threadId = ThreadId.make(yield* Effect.orDie(crypto.randomUUIDv4()));
      // Filed first, so the task is born in the note's home, not its project's.
      yield* folders
        .moveThread({ threadId, folderId: folder?.id ?? null })
        .pipe(Effect.catchTags({ FolderRefusedError: (error) => refuse(error.message) }));
      const contextIds = yield* drives.contextIds;
      const task = noteTask(row, offer, folder);
      yield* threads
        .launchThread(
          { userId: user, contextIds },
          {
            commandId: CommandId.make(`note:${row.id}:${threadId}`),
            threadId,
            creationSource: "server",
            projectId: task.projectId,
            title: task.title,
            generateTitle: false,
            modelSelection: input.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: { type: "root" },
            initialMessage: { text: task.text, attachments: [] },
          },
        )
        .pipe(
          Effect.catchTags({
            ThreadNotFoundError: launchRefusal,
            ThreadCommandRejectedError: launchRefusal,
            ThreadObjectError: launchRefusal,
          }),
        );
      yield* changedWith(
        Effect.as(
          sql`UPDATE notes SET accepted_thread_id = ${threadId} WHERE id = ${row.id}`,
          true,
        ),
      );
      yield* Effect.annotateCurrentSpan("thread.id", threadId);
      return { threadId };
    }).pipe(accepting.withPermits(1), traced("UserNotes.accept", { "note.id": input.id }));

  const listForAgent: UserNotes["Service"]["listForAgent"] = (input) =>
    Effect.gen(function* () {
      const { state: current, home } = yield* folders.threadHome(input.threadId);
      const chain = chainFolderIds(current.tree, home);
      const rows =
        chain.length === 0
          ? []
          : decodeNoteRows(
              yield* sql`SELECT id, folder_id, author_id, visibility, text, created_at, reading,
                accepted_thread_id FROM notes
                WHERE visibility = 'team' AND accepted_thread_id IS NULL
                  AND folder_id IN ${sql.in(chain)}
                ORDER BY created_at DESC, id DESC`,
            );
      const notes = agentNotes(current.tree, home, rows);
      yield* Effect.annotateCurrentSpan({
        "folder.id": home ?? "top",
        "notes.count": notes.length,
      });
      return notes;
    }).pipe(traced("UserNotes.listForAgent", { "thread.id": input.threadId }));

  return UserNotes.of({
    snapshot,
    changes,
    create,
    update,
    delete: remove,
    readAgain,
    dismissReading,
    accept,
    listForAgent,
  });
});

export const layer = Layer.effect(UserNotes, make);
