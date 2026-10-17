import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { FolderId, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import type { NoteReading, SignalboxNotesSnapshot } from "@t3tools/contracts/signalboxNotes";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemoryStore } from "../testing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as UserContexts from "../user/UserContexts.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserStore from "../user/UserStore.ts";
import * as NoteReader from "./NoteReader.ts";
import { layer, UserNotes } from "./UserNotes.ts";

const USER = "user_1";
const ACME = SignalboxContextId.make("org_acme");
const MODEL = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };

/** Offers what the note says unless it's "vague"; "#456" waits for that pull request. */
const fakeReading = (request: NoteReader.ReadRequest): Option.Option<NoteReading> =>
  Option.some(
    request.text.includes("vague")
      ? { _tag: "unclear", reader: request.reader }
      : {
          _tag: "offer",
          reader: request.reader,
          meaning: `Meant: ${request.text}`,
          action: "Start a task to do it.",
          ...(request.text.includes("#456")
            ? { condition: { _tag: "pullRequestMerged", number: 456 } }
            : {}),
          dismissed: false,
        },
  );

const unused = () => Effect.die("not used by notes");

/**
 * Notes on a fresh user object: reads answered by `read` (`fakeReading` at
 * once by default), and launches recorded with the folder the thread was
 * filed in when it launched.
 */
const setup = (
  read: (request: NoteReader.ReadRequest) => Effect.Effect<Option.Option<NoteReading>> = (
    request,
  ) => Effect.sync(() => fakeReading(request)),
) => {
  const reads: Array<NoteReader.ReadRequest> = [];
  const launches: Array<{
    readonly input: OrchestrationV2ThreadLaunchInput;
    readonly filedIn: FolderId | null | undefined;
  }> = [];
  const threads = Layer.effect(
    CloudThreadService.CloudThreadService,
    Effect.gen(function* () {
      const folders = yield* UserFolders.UserFolders;
      return CloudThreadService.CloudThreadService.of({
        launchThread: (_actor, input) =>
          Effect.gen(function* () {
            const filed = (yield* Effect.orDie(folders.snapshot)).threadHomes.find(
              (home) => home.threadId === input.threadId,
            );
            launches.push({ input, filedIn: filed?.folderId });
            return {
              threadId: input.threadId!,
              projection: {} as OrchestrationV2ThreadProjection,
              resumed: false,
            };
          }),
        dispatchCommand: unused,
        threadSnapshot: unused,
        threadHistoryPage: unused,
        requestPullRequestSync: unused,
        subscribeThread: () => Stream.die("not used by notes"),
        previews: () => Stream.die("not used by notes"),
        browsing: () => Stream.die("not used by notes"),
        browse: unused,
        browsingRecord: unused,
        openPreview: unused,
        browserWatch: () => Stream.die("not used by notes"),
        browserInput: unused,
        browserTrail: unused,
        browserStep: unused,
        turnDiagnostics: unused,
        canSee: unused,
      });
    }),
  );
  return {
    reads,
    launches,
    layer: Layer.fresh(
      layer.pipe(
        Layer.provide(
          Layer.succeed(
            NoteReader.NoteReader,
            NoteReader.NoteReader.of({
              read: (request) => Effect.suspend(() => (reads.push(request), read(request))),
            }),
          ),
        ),
        Layer.provideMerge(threads),
        Layer.provideMerge(UserDrives.layer),
        Layer.provideMerge(layerMemoryStore),
      ),
    ),
  };
};

const services = Effect.all({
  notes: UserNotes,
  folders: UserFolders.UserFolders,
  contexts: UserContexts.UserContexts,
  store: UserStore.UserStore,
});

/** The first snapshot, now or after a change, that `done` accepts: what a client sees next. */
const until = (done: (snapshot: SignalboxNotesSnapshot) => boolean) =>
  UserNotes.use((notes) =>
    notes.changes.pipe(Stream.filter(done), Stream.runHead, Effect.map(Option.getOrThrow)),
  );

const noteWith = (snapshot: SignalboxNotesSnapshot, text: string) => {
  const found = snapshot.notes.find((note) => note.text === text);
  if (!found) throw new Error(`no note ${text}`);
  return found;
};

const readOf = (text: string) => (snapshot: SignalboxNotesSnapshot) =>
  snapshot.notes.some((note) => note.text === text && note.reading !== undefined);

const idOf = (snapshot: SignalboxFoldersSnapshot, name: string) => {
  const found = snapshot.folders.find((folder) => folder.name === name);
  if (!found) throw new Error(`no folder ${name}`);
  return found.id;
};

const messageOf = <A, R>(effect: Effect.Effect<A, { readonly _tag: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ("message" in error ? error.message : error._tag)),
  );

/** Signed in, in Acme, with Acme's Payments › Cards and Sales, and a Personal Journal. */
const world = Effect.gen(function* () {
  const { folders, contexts, store } = yield* services;
  yield* store.recordSignIn({ id: USER, email: "a@b.c" });
  yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
  let snapshot = yield* folders.create({ name: "Payments", parentId: null, ownerId: ACME });
  snapshot = yield* folders.create({ name: "Cards", parentId: idOf(snapshot, "Payments") });
  snapshot = yield* folders.create({ name: "Sales", parentId: null, ownerId: ACME });
  snapshot = yield* folders.create({ name: "Journal", parentId: null });
  return {
    payments: idOf(snapshot, "Payments"),
    cards: idOf(snapshot, "Cards"),
    sales: idOf(snapshot, "Sales"),
    journal: idOf(snapshot, "Journal"),
  };
});

const folderHome = (folderId: FolderId) => ({ _tag: "folder" as const, folderId });

describe("UserNotes", () => {
  it.effect(
    "reads a new note in the background, as its author's assistant or its folder's agent",
    () => {
      const test = setup();
      return Effect.gen(function* () {
        const { notes } = yield* services;
        const { payments } = yield* world;

        yield* notes.create({ home: { _tag: "top" }, text: "renew the domain" });
        const top = noteWith(yield* until(readOf("renew the domain")), "renew the domain");
        expect(top).toMatchObject({
          home: { _tag: "top" },
          authorId: USER,
          visibility: "private",
          reading: {
            _tag: "offer",
            reader: "assistant",
            meaning: "Meant: renew the domain",
            dismissed: false,
          },
        });
        expect(test.reads[0]).toMatchObject({
          reader: "assistant",
          folderName: null,
          context: [],
          pool: { objectName: `${USER}:personal`, userId: USER },
        });

        // A private and a team note on Payments' pad, then one of each read with them as context.
        for (const [text, visibility] of [
          ["mine only", "private"],
          ["for everyone", "team"],
          ["team idea", "team"],
          ["private idea", "private"],
        ] as const) {
          yield* TestClock.adjust("1 minute");
          yield* notes.create({ home: folderHome(payments), text, visibility });
        }
        yield* until((snapshot) => snapshot.notes.every((note) => note.reading !== undefined));
        const teamRead = test.reads.find((read) => read.text === "team idea")!;
        expect(teamRead).toMatchObject({ reader: "folder", folderName: "Payments" });
        // A team read sees only the team's notes; a private read sees both.
        expect(teamRead.context.map((note) => note.text)).toEqual(["for everyone"]);
        expect(
          test.reads.find((read) => read.text === "private idea")!.context.map((note) => note.text),
        ).toEqual(["team idea", "for everyone", "mine only"]);
        expect(noteWith(yield* notes.snapshot, "team idea").reading).toMatchObject({
          _tag: "offer",
          reader: "folder",
        });

        // Nothing an agent could do: a plain note, read as unclear.
        yield* notes.create({ home: { _tag: "top" }, text: "feeling vague today" });
        expect(
          noteWith(yield* until(readOf("feeling vague today")), "feeling vague today").reading,
        ).toEqual({ _tag: "unclear", reader: "assistant" });
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("keeps top-level notes and Personal folders' notes private", () => {
    const test = setup();
    return Effect.gen(function* () {
      const { notes } = yield* services;
      const { journal, sales } = yield* world;
      expect(
        yield* messageOf(notes.create({ home: { _tag: "top" }, text: "a", visibility: "team" })),
      ).toBe("Notes at the top level stay private.");
      expect(
        yield* messageOf(
          notes.create({ home: folderHome(journal), text: "b", visibility: "team" }),
        ),
      ).toBe("Only notes in an organization's folders can be shared with its team.");
      const snapshot = yield* notes.create({ home: folderHome(journal), text: "c" });
      expect(
        yield* messageOf(notes.update({ id: snapshot.notes[0]!.id, visibility: "team" })),
      ).toBe("Only notes in an organization's folders can be shared with its team.");
      expect(
        yield* messageOf(notes.create({ home: folderHome("gone" as FolderId), text: "d" })),
      ).toBe("That folder no longer exists.");
      const shared = yield* notes.create({
        home: folderHome(sales),
        text: "e",
        visibility: "team",
      });
      expect(noteWith(shared, "e").visibility).toBe("team");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("reads changed words or a changed reader again, and only then", () => {
    const test = setup();
    return Effect.gen(function* () {
      const { notes } = yield* services;
      const { sales } = yield* world;
      yield* notes.create({ home: folderHome(sales), text: "call the bank" });
      const id = noteWith(yield* until(readOf("call the bank")), "call the bank").id;

      yield* notes.update({ id, text: "call the bank" });
      expect(test.reads).toHaveLength(1);

      yield* notes.update({ id, text: "email the bank" });
      expect(
        noteWith(yield* until(readOf("email the bank")), "email the bank").reading,
      ).toMatchObject({ meaning: "Meant: email the bank", reader: "assistant" });

      yield* notes.update({ id, visibility: "team" });
      const shared = yield* until((snapshot) =>
        snapshot.notes.some((note) => note.reading?.reader === "folder"),
      );
      expect(noteWith(shared, "email the bank")).toMatchObject({ visibility: "team" });
      expect(test.reads.map((read) => [read.text, read.reader])).toEqual([
        ["call the bank", "assistant"],
        ["email the bank", "assistant"],
        ["email the bank", "folder"],
      ]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("dismissing an offer keeps the note; reading it again offers afresh", () => {
    const test = setup();
    return Effect.gen(function* () {
      const { notes } = yield* services;
      yield* world;
      yield* notes.create({ home: { _tag: "top" }, text: "book flights" });
      const id = noteWith(yield* until(readOf("book flights")), "book flights").id;

      const dismissed = noteWith(yield* notes.dismissReading({ id }), "book flights");
      expect(dismissed.reading).toMatchObject({ _tag: "offer", dismissed: true });
      expect(yield* messageOf(notes.accept({ id, modelSelection: MODEL }))).toBe(
        "That note has no offer to accept.",
      );

      yield* notes.readAgain({ id });
      const fresh = yield* until((snapshot) =>
        snapshot.notes.some((note) => note.reading?._tag === "offer" && !note.reading.dismissed),
      );
      expect(noteWith(fresh, "book flights").reading).toMatchObject({ dismissed: false });
      expect(test.reads).toHaveLength(2);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("dismissing a reading that's since been replaced changes nothing", () => {
    const gate = Deferred.makeUnsafe<void>();
    let count = 0;
    // The first read answers at once; the next waits for the gate.
    const test = setup((request) =>
      (count++ === 0 ? Effect.void : Deferred.await(gate)).pipe(Effect.as(fakeReading(request))),
    );
    return Effect.gen(function* () {
      const { notes } = yield* services;
      yield* world;
      yield* notes.create({ home: { _tag: "top" }, text: "book flights" });
      const id = noteWith(yield* until(readOf("book flights")), "book flights").id;

      const cleared = yield* notes.readAgain({ id });
      expect(noteWith(cleared, "book flights").reading).toBeUndefined();
      const after = yield* notes.dismissReading({ id });
      expect(after.revision).toBe(cleared.revision);
      expect(noteWith(after, "book flights").reading).toBeUndefined();

      yield* Deferred.succeed(gate, undefined);
      const fresh = noteWith(yield* until(readOf("book flights")), "book flights");
      expect(fresh.reading).toMatchObject({ _tag: "offer", dismissed: false });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "accepting files the task in the note's home before launching it with the note's words",
    () => {
      const test = setup();
      return Effect.gen(function* () {
        const { notes } = yield* services;
        const { cards } = yield* world;
        yield* notes.create({
          home: folderHome(cards),
          text: "switch the card issuer after #456 merges",
          visibility: "team",
        });
        const note = noteWith(
          yield* until(readOf("switch the card issuer after #456 merges")),
          "switch the card issuer after #456 merges",
        );

        const { threadId } = yield* notes.accept({ id: note.id, modelSelection: MODEL });
        expect(test.launches).toHaveLength(1);
        const [launch] = test.launches;
        expect(launch!.filedIn).toBe(cards);
        expect(launch!.input).toMatchObject({
          threadId,
          projectId: "context:org_acme",
          title: "Meant: switch the card issuer after #456 merges",
          modelSelection: MODEL,
          creationSource: "server",
          generateTitle: false,
        });
        expect(launch!.input.initialMessage?.text).toBe(
          [
            "switch the card issuer after #456 merges",
            "",
            "From my notes. The Cards agent read it as: Meant: switch the card issuer after #456 merges Start a task to do it.",
            "Prepare it now, but don't land anything until #456 merges, and say that's what it's waiting on.",
          ].join("\n"),
        );
        // Off the pad, linked to its task; it starts nothing twice.
        expect(noteWith(yield* notes.snapshot, note.text).acceptedThreadId).toBe(threadId);
        expect(yield* messageOf(notes.accept({ id: note.id, modelSelection: MODEL }))).toBe(
          "That note is already a task.",
        );

        // Nothing to accept until it's read as an offer.
        yield* notes.create({ home: { _tag: "top" }, text: "so vague" });
        const vague = noteWith(yield* until(readOf("so vague")), "so vague");
        expect(yield* messageOf(notes.accept({ id: vague.id, modelSelection: MODEL }))).toBe(
          "That note has no offer to accept.",
        );
        expect(test.launches).toHaveLength(1);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("hides a folder's notes in Trash and restores their original home and reading", () => {
    const test = setup();
    return Effect.gen(function* () {
      const { notes, folders } = yield* services;
      const { cards } = yield* world;
      yield* notes.create({ home: folderHome(cards), text: "rotate keys", visibility: "team" });
      yield* until(readOf("rotate keys"));
      const before = noteWith(yield* notes.snapshot, "rotate keys");

      const trashed = yield* folders.trash({ id: cards });
      expect((yield* notes.snapshot).notes.some((note) => note.id === before.id)).toBe(false);
      expect(yield* messageOf(notes.update({ id: before.id, text: "change while hidden" }))).toBe(
        "That folder no longer exists.",
      );
      expect(yield* messageOf(notes.readAgain({ id: before.id }))).toBe(
        "That folder no longer exists.",
      );

      yield* folders.restoreTrash(trashed.trash.trashId);
      expect(noteWith(yield* notes.snapshot, "rotate keys")).toEqual(before);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "stops a read when its folder is trashed and restores the note without a stale reading",
    () => {
      const started = Deferred.makeUnsafe<void>();
      const interrupted = Deferred.makeUnsafe<void>();
      const test = setup(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );
      return Effect.gen(function* () {
        const { notes, folders } = yield* services;
        const { cards } = yield* world;
        yield* notes.create({ home: folderHome(cards), text: "rotate keys", visibility: "team" });
        yield* Deferred.await(started);

        const trashed = yield* folders.trash({ id: cards });
        yield* Deferred.await(interrupted);
        expect((yield* notes.snapshot).notes.some((note) => note.text === "rotate keys")).toBe(
          false,
        );
        yield* folders.restoreTrash(trashed.trash.trashId);
        const note = noteWith(yield* notes.snapshot, "rotate keys");
        expect(note.home).toEqual(folderHome(cards));
        expect(note.reading).toBeUndefined();
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("lists only the team notes on a thread's home chain for its agent", () => {
    const test = setup();
    return Effect.gen(function* () {
      const { notes, folders } = yield* services;
      const { payments, cards, sales } = yield* world;
      const threadId = ThreadId.make("thread-cards");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO thread_index (thread_id, context_id, revision, shell, updated_at)
        VALUES (${threadId}, ${ACME}, 1, ${JSON.stringify({ id: threadId, projectId: "context:org_acme" })}, 0)`;
      yield* folders.moveThread({ threadId, folderId: cards });

      yield* notes.create({ home: folderHome(payments), text: "above", visibility: "team" });
      yield* TestClock.adjust("1 minute");
      yield* notes.create({ home: folderHome(cards), text: "home", visibility: "team" });
      yield* notes.create({ home: folderHome(cards), text: "secret" });
      yield* notes.create({ home: folderHome(sales), text: "elsewhere", visibility: "team" });
      yield* notes.create({ home: { _tag: "top" }, text: "top" });
      yield* until((snapshot) => snapshot.notes.every((note) => note.reading !== undefined));

      const listed = yield* notes.listForAgent({ threadId });
      expect(listed.map((note) => [note.text, note.folder])).toEqual([
        ["home", "Cards"],
        ["above", "Payments"],
      ]);
      expect(listed[0]).toMatchObject({
        offer: { meaning: "Meant: home", action: "Start a task to do it." },
      });
      expect(listed[0]!.createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A thread at the top level reads no notes.
      expect(yield* notes.listForAgent({ threadId: ThreadId.make("thread-top") })).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });
});
