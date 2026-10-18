import {
  CONTEXT_PATHS,
  contextJson,
  type ContextSearchResult,
  type ThreadResult,
  type TreeResult,
} from "@signalbox/runner-protocol/ContextProtocol";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  ProjectId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { SIGNALBOX_DRIVES_WS_METHODS } from "@t3tools/contracts/signalboxDrives";
import type { ThreadSearchInput, ThreadSearchResult } from "@t3tools/contracts/signalboxSearch";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SearchActor } from "../search/ThreadSearch.ts";
import * as RpcTest from "effect/rpc/RpcTest";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { MAIN_REF, threadRef, wipRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { makeMemoryCloud } from "../testing.ts";
import { pauseTaskDone } from "../automations/taskLifecycleTesting.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { ThreadDirectory } from "../thread/ThreadDirectory.ts";
import * as CloudRpc from "../user/rpc.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import { serveContextRequest } from "./contextRoutes.ts";
import { type ContextReader, layer as layerContextTool } from "./ContextTool.ts";

/**
 * #141 from the cloud's side: what a thread's machine reads through the
 * context API. Alice works in her Personal My Drive; Acme's shared drive
 * "Billing" holds a dark mode toggle another of her threads built, and Bob's
 * unfinished invoice export. Carol is in no organization and reads none of it.
 */

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const ACME = SignalboxContextId.make("org_acme");
const PEOPLE = [
  { userId: "user_alice", email: "alice@acme.test", name: "Alice", organizations: [ACME] },
  { userId: "user_bob", email: "bob@acme.test", name: "Bob", organizations: [ACME] },
  { userId: "user_carol", email: "carol@example.test", name: "Carol", organizations: [] },
] as const;

const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud({ people: PEOPLE });
  const searchCalls: Array<{ userId: string; actor: SearchActor; input: ThreadSearchInput }> = [];
  const itemReads: Array<{
    userId: string;
    actor: SearchActor;
    threadId: ThreadId;
    itemId: string;
  }> = [];
  const deniedDriveAccess = new Set<string>();
  let revokeOnNextSearch: string | null = null;
  let revokeOnNextItemRead: string | null = null;
  const contextUsers = new Proxy(cloud.userDirectory, {
    get(target, property, receiver) {
      if (property !== "forUser") return Reflect.get(target, property, receiver);
      return (userId: string) =>
        new Proxy(target.forUser(userId), {
          get(user, operation, userReceiver) {
            if (operation === "searchThreads") {
              return (actor: SearchActor, input: ThreadSearchInput) => {
                searchCalls.push({ userId, actor, input });
                if (revokeOnNextSearch !== null) {
                  deniedDriveAccess.add(revokeOnNextSearch);
                  revokeOnNextSearch = null;
                }
                const projectIds = actor.projectIds;
                const archivedProjectId = projectIds?.find((id) =>
                  String(id).startsWith("drive:shared/org_acme/"),
                );
                if (input.query === "archive probe" && archivedProjectId !== undefined) {
                  return Effect.succeed({
                    hits: [
                      {
                        threadId: ThreadId.make("archived-search-thread"),
                        projectId: ProjectId.make(archivedProjectId),
                        title: "Old billing decision",
                        archived: true,
                        itemId: "archived-search-item",
                        entryId: "archived-search-entry",
                        runId: null,
                        position: 2,
                        kind: "summary",
                        snippet: "archive probe",
                        createdAt: null,
                        sourceSequence: 5,
                        indexedThrough: 5,
                      },
                    ],
                    nextCursor: "opaque-search-cursor",
                    coverage: {
                      complete: true,
                      indexedThreads: 1,
                      pendingThreads: 0,
                      available: true,
                    },
                  } satisfies ThreadSearchResult);
                }
                return user.searchThreads(actor, input);
              };
            }
            if (operation === "driveAccess") {
              return (driveId: string) =>
                deniedDriveAccess.has(`${userId}/${driveId}`)
                  ? Effect.succeed(null)
                  : user.driveAccess(driveId);
            }
            if (operation === "readSearchItem") {
              return (actor: SearchActor, threadId: ThreadId, itemId: string) => {
                itemReads.push({ userId, actor, threadId, itemId });
                if (revokeOnNextItemRead !== null) {
                  deniedDriveAccess.add(revokeOnNextItemRead);
                  revokeOnNextItemRead = null;
                }
                if (threadId === "archived-search-thread" && itemId === "archived-search-item") {
                  const projectId = actor.projectIds?.find((id) =>
                    String(id).startsWith("drive:shared/org_acme/"),
                  );
                  if (projectId === undefined) return Effect.succeed(null);
                  return Effect.succeed({
                    snapshotSequence: 5,
                    projectId,
                    title: "Old billing decision",
                    archived: true,
                    item: {
                      itemId,
                      entryId: "archived-search-entry",
                      runId: null,
                      position: 2,
                      kind: "summary" as const,
                      text: "archive probe exact result",
                      createdAt: null,
                    },
                  });
                }
                return user.readSearchItem(actor, threadId, itemId);
              };
            }
            return Reflect.get(user, operation, userReceiver);
          },
        });
    },
  });
  const clientOf = (person: (typeof PEOPLE)[number]) =>
    Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(person.userId);
      yield* user.recordSignIn({ id: person.userId, email: person.email, firstName: person.name });
      yield* user.syncOrganizations(person.organizations.map((id) => ({ id, name: "Acme" })));
      return yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, userId: person.userId, sid: "test-session" }),
            CloudRpc.layerScopeAuthorization([
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
              AuthFilesystemReadScope,
            ]),
          ).pipe(Layer.provide(cloud.layerFor(person.userId))),
        ),
      );
    });
  const alice = yield* clientOf(PEOPLE[0]);
  const bob = yield* clientOf(PEOPLE[1]);
  yield* clientOf(PEOPLE[2]);
  const tool = layerContextTool.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(UserDirectory, contextUsers),
        Layer.succeed(ThreadDirectory, cloud.threadDirectory),
        cloud.drives.layer,
      ),
    ),
  );
  /** One context request as a machine makes it, decoded. */
  const call = <A>(
    reader: ContextReader,
    path: string,
    request: unknown,
    decode: (text: string) => A,
  ) =>
    serveContextRequest(reader, path, JSON.stringify(request)).pipe(
      Effect.provide(tool),
      Effect.map((answer) => ({
        status: answer.status,
        body: answer.status === 200 && typeof answer.body === "string" ? decode(answer.body) : null,
        raw: answer.body,
      })),
    );
  return {
    cloud,
    alice,
    bob,
    call,
    searchCalls,
    itemReads,
    denyDrive: (userId: string, driveId: string) => deniedDriveAccess.add(`${userId}/${driveId}`),
    allowDrive: (userId: string, driveId: string) =>
      deniedDriveAccess.delete(`${userId}/${driveId}`),
    revokeDuringNextSearch: (userId: string, driveId: string) => {
      revokeOnNextSearch = `${userId}/${driveId}`;
    },
    revokeDuringNextItemRead: (userId: string, driveId: string) => {
      revokeOnNextItemRead = `${userId}/${driveId}`;
    },
  };
});

type Client = Effect.Success<typeof setup>["alice"];

const launch = (client: Client, threadId: ThreadId, projectId: string, text: string) =>
  client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make(`launch-${threadId}`),
    threadId,
    projectId: projectId as never,
    title: text.slice(0, 40),
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make(`m-${threadId}`), text, attachments: [] },
  });

/** A thread's machine saving work: a pack, then its branch (`land`) or only its auto-save. */
const save = (
  cloud: Effect.Success<typeof setup>["cloud"],
  input: {
    readonly driveId: string;
    readonly threadId: string;
    readonly userId: string;
    readonly head: string;
    readonly packed: ReturnType<ReturnType<typeof makeRepo>["pack"]>;
    readonly land: boolean;
  },
) =>
  Effect.gen(function* () {
    const uploaded = yield* uploadPack({
      driveId: input.driveId,
      threadId: input.threadId,
      idx: input.packed.idx,
      pack: input.packed.pack,
    });
    expect(uploaded._tag).toBe("ok");
    const drive = (yield* DriveDirectory).forDrive(input.driveId);
    const writer = { ...input, generation: 1, live: true, packsAfter: 0 };
    const opened = yield* drive.open(writer);
    if (opened._tag !== "ok") throw new Error(opened._tag);
    if (!input.land) {
      return yield* drive.updateRefs(writer, [
        { name: wipRef(input.threadId), old: null, new: input.head },
      ]);
    }
    yield* drive.updateRefs(writer, [
      { name: threadRef(input.threadId), old: opened.refs.thread, new: input.head },
    ]);
    return yield* drive.reconcile(writer, { expectedMain: opened.refs.main, newMain: input.head });
  }).pipe(Effect.provide(cloud.drives.layer));

const world = Effect.gen(function* () {
  const env = yield* setup;
  const { cloud, alice, bob } = env;
  const billing = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
    contextId: ACME,
    name: "Billing",
  });
  yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
    driveId: billing.id,
    email: "bob@acme.test",
    role: "contributor",
  });

  yield* pauseTaskDone(cloud, "user_alice", billing.projectId);
  yield* pauseTaskDone(cloud, "user_bob", billing.projectId);
  yield* pauseTaskDone(cloud, "user_alice", "scratch");
  // Alice's thread in Billing built the toggle; its files landed on `main`.
  const toggleThread = ThreadId.make("thread-dark-mode");
  yield* launch(alice, toggleThread, billing.projectId, "Add a dark mode toggle to the settings");
  const git = makeRepo();
  repos.push(git);
  git.write("README.md", "Billing\n");
  const first = git.commit("Start");
  git.write("theme/darkMode.ts", "export const darkMode = (on: boolean) => on;\n");
  const toggle = git.commit("Add a dark mode toggle to the settings");
  yield* save(cloud, {
    driveId: billing.id,
    threadId: toggleThread,
    userId: "user_alice",
    head: toggle,
    packed: git.pack([toggle]),
    land: true,
  });

  // Bob's invoice export is saved but not reconciled.
  const exportThread = ThreadId.make("thread-bob-export");
  yield* launch(bob, exportThread, billing.projectId, "Export invoices");
  git.write("invoices/export.csv", "id,total\n");
  const exportWip = git.commit("Auto-save");
  yield* save(cloud, {
    driveId: billing.id,
    threadId: exportThread,
    userId: "user_bob",
    head: exportWip,
    packed: git.pack([exportWip], [toggle]),
    land: false,
  });

  // Alice now works in her Personal My Drive.
  const here = ThreadId.make("thread-alice-here");
  yield* launch(alice, here, "scratch", "Add a dark mode toggle like Billing has");
  yield* cloud.settle;
  const reader: ContextReader = {
    userId: "user_alice",
    threadId: here,
    driveId: "my/personal/user_alice",
  };
  return { ...env, git, billing, toggleThread, first, toggle, exportWip, reader };
});

const search = (
  env: Effect.Success<typeof world>,
  query: string,
  driveId: string | null = null,
  reader = env.reader,
) =>
  Effect.map(
    env.call(reader, CONTEXT_PATHS.search, { query, driveId }, contextJson.search.decode),
    (answer) => answer.body as ContextSearchResult,
  );

describe("context API (#141)", () => {
  it.effect("a fork keeps its checkpoint's input view until explicitly updated", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const { cloud, git, billing, toggleThread, toggle } = env;
      const reader = { ...env.reader, driveId: billing.id, threadId: toggleThread };
      const view = (yield* env.call(reader, CONTEXT_PATHS.view, {}, contextJson.view.decode)).body!;
      const record = {
        runId: "run-toggle",
        turnId: "run-toggle",
        commit: toggle,
        start: env.first,
        views: { shortcuts: [], context: view },
      };
      git.git([
        "notes",
        "--ref=signalbox/checkpoints",
        "add",
        "-m",
        JSON.stringify(record),
        toggle,
      ]);
      const notes = git.git(["rev-parse", "refs/notes/signalbox/checkpoints"]);
      yield* uploadPack({
        driveId: billing.id,
        threadId: toggleThread,
        ...git.pack([notes], [env.exportWip]),
      }).pipe(Effect.provide(cloud.drives.layer));
      const handle = cloud.drives.apiFor(billing.id);
      const writer = {
        threadId: toggleThread,
        userId: reader.userId,
        generation: 1,
        live: true,
        packsAfter: 0,
      };
      expect(
        (yield* Effect.promise(() => handle.recordCheckpoint(writer, { ...record, notes })))._tag,
      ).toBe("ok");
      const fork = yield* Effect.promise(() =>
        handle.forkCheckpoint(reader.userId, {
          sourceThreadId: toggleThread,
          runId: record.runId,
          threadId: "thread-pinned-inputs",
          operationId: "fork-inputs",
        }),
      );
      expect(fork._tag).toBe("ok");

      git.write("spec.md", "Today's spec, after the fork\n");
      const latest = git.commit("Update the spec");
      yield* save(cloud, {
        driveId: billing.id,
        threadId: "thread-new-spec",
        userId: reader.userId,
        head: latest,
        packed: git.pack([latest], [env.exportWip]),
        land: true,
      });
      const child = { ...reader, threadId: "thread-pinned-inputs" };
      const pinned = (yield* env.call(child, CONTEXT_PATHS.view, {}, contextJson.view.decode))
        .body!;
      expect(pinned).toEqual(view);
      const current = (yield* env.call(reader, CONTEXT_PATHS.view, {}, contextJson.view.decode))
        .body!;
      expect(
        current.contexts
          .flatMap((context) => context.drives)
          .find((drive) => drive.driveId === billing.id)?.commit,
      ).toBe(latest);

      const updated = yield* Effect.promise(() =>
        handle.updateToLatest(reader.userId, {
          threadId: child.threadId,
          operationId: "update-inputs",
          expectedThread: toggle,
          expectedWip: toggle,
          generation: 0,
        }),
      );
      expect(updated._tag).toBe("ok");
      const refreshed = (yield* env.call(child, CONTEXT_PATHS.view, {}, contextJson.view.decode))
        .body!;
      expect(
        refreshed.contexts
          .flatMap((context) => context.drives)
          .find((drive) => drive.driveId === billing.id)?.commit,
      ).toBe(latest);
    }),
  );

  it.effect("lists every readable drive, pinned, and reads another drive's files", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const { call, reader, billing, toggle } = env;
      const view = (yield* call(reader, CONTEXT_PATHS.view, {}, contextJson.view.decode)).body!;
      expect(view.driveId).toBe("my/personal/user_alice");
      expect(view.contexts.map((context) => context.name)).toEqual(["Personal", "Acme"]);
      const acme = view.contexts.find((context) => context.contextId === ACME)!;
      expect(acme.drives.map((drive) => drive.path)).toEqual(["My Drive", "Shared drives/Billing"]);
      const pinned = acme.drives.find((drive) => drive.driveId === billing.id)!;
      expect(pinned.commit).toBe(toggle);

      const tree = (yield* call(
        reader,
        CONTEXT_PATHS.tree,
        { driveId: billing.id, commit: toggle, path: "theme" },
        contextJson.tree.decode,
      )).body as TreeResult;
      expect(tree).toMatchObject({
        _tag: "directory",
        entries: [{ name: "darkMode.ts", kind: "file", size: 45 }],
      });
      const oid = tree._tag === "directory" ? tree.entries[0]!.oid : "";
      const blob = yield* call(reader, CONTEXT_PATHS.blob, { driveId: billing.id, oid }, String);
      expect(new TextDecoder().decode(blob.raw as Uint8Array)).toBe(
        "export const darkMode = (on: boolean) => on;\n",
      );
      // A commit the drive doesn't have reads as nothing, not as someone else's files.
      const elsewhere = yield* call(
        reader,
        CONTEXT_PATHS.tree,
        { driveId: billing.id, commit: "f".repeat(40), path: "" },
        contextJson.tree.decode,
      );
      expect(elsewhere.body).toEqual({ _tag: "missing" });
    }),
  );

  it.effect("refuses drives the user can't read", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const carol: ContextReader = {
        userId: "user_carol",
        threadId: "thread-carol",
        driveId: "my/personal/user_carol",
      };
      const read = yield* env.call(
        carol,
        CONTEXT_PATHS.tree,
        { driveId: env.billing.id, commit: env.toggle, path: "" },
        contextJson.tree.decode,
      );
      expect(read.status).toBe(403);
      const view = (yield* env.call(carol, CONTEXT_PATHS.view, {}, contextJson.view.decode)).body!;
      expect(
        view.contexts.flatMap((context) => context.drives.map((drive) => drive.driveId)),
      ).toEqual(["my/personal/user_carol"]);
      const noSearch = yield* search(env, "dark mode toggle", null, carol);
      expect(noSearch.hits).toEqual([]);
      expect(noSearch.driveHits).toEqual([]);
    }),
  );

  it.effect("keeps indexed search owner-scoped, including archived items and exact reads", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const reader = { ...env.reader, driveId: env.billing.id };
      const found = (yield* env.call(
        reader,
        CONTEXT_PATHS.search,
        { query: "archive probe", driveId: null, projectIds: [env.billing.projectId] },
        contextJson.search.decode,
      )).body as ContextSearchResult;
      expect(found).toMatchObject({
        hits: [
          {
            threadId: "archived-search-thread",
            projectId: env.billing.projectId,
            archived: true,
            itemId: "archived-search-item",
          },
        ],
        nextCursor: "opaque-search-cursor",
        coverage: { complete: true, available: true },
      });
      expect(env.searchCalls.at(-1)).toMatchObject({
        userId: "user_alice",
        actor: { userId: "user_alice", contextIds: [ACME], projectIds: [env.billing.projectId] },
        input: { query: "archive probe", projectIds: [env.billing.projectId] },
      });

      const opened = (yield* env.call(
        reader,
        CONTEXT_PATHS.thread,
        {
          threadId: "archived-search-thread",
          itemId: "archived-search-item",
          projectId: env.billing.projectId,
        },
        contextJson.thread.decode,
      )).body as ThreadResult;
      expect(opened).toMatchObject({
        _tag: "item",
        threadId: "archived-search-thread",
        archived: true,
        item: { itemId: "archived-search-item", text: "archive probe exact result" },
      });
      expect(env.itemReads.at(-1)).toMatchObject({
        userId: "user_alice",
        actor: { userId: "user_alice", contextIds: [ACME], projectIds: [env.billing.projectId] },
        threadId: "archived-search-thread",
        itemId: "archived-search-item",
      });

      // A personal thread token cannot search the Acme index for this user.
      const crossOwner = yield* search(env, "archive probe");
      expect(crossOwner.hits).toEqual([]);
      expect(env.searchCalls.at(-1)).toMatchObject({
        actor: { contextIds: [SignalboxContextId.make("personal")] },
      });
      expect(env.searchCalls.at(-1)?.actor.projectIds).not.toContain(env.billing.projectId);
    }),
  );

  it.effect("rechecks live drive roles when the readable-drive index is stale", () =>
    Effect.gen(function* () {
      const env = yield* world;
      env.denyDrive("user_alice", env.billing.id);

      // A stale listing cannot keep a revoked target drive in search scope.
      const personalSearch = yield* search(env, "archive probe");
      expect(personalSearch.hits).toEqual([]);
      expect(env.searchCalls.at(-1)?.actor.projectIds).not.toContain(env.billing.projectId);

      // The same stale listing cannot authorize a request from that revoked drive.
      const revokedReader = { ...env.reader, driveId: env.billing.id };
      const deniedSearch = yield* env.call(
        revokedReader,
        CONTEXT_PATHS.search,
        { query: "archive probe", driveId: null },
        contextJson.search.decode,
      );
      const deniedItem = yield* env.call(
        revokedReader,
        CONTEXT_PATHS.thread,
        {
          threadId: "archived-search-thread",
          itemId: "archived-search-item",
          projectId: env.billing.projectId,
        },
        contextJson.thread.decode,
      );
      expect(deniedSearch.status).toBe(403);
      expect(deniedItem.status).toBe(403);
      expect(env.searchCalls).toHaveLength(1);
      expect(env.itemReads).toEqual([]);
    }),
  );

  it.effect("rechecks drive access after indexed search and item reads", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const reader = { ...env.reader, driveId: env.billing.id };
      env.revokeDuringNextSearch("user_alice", env.billing.id);
      const search = yield* env.call(
        reader,
        CONTEXT_PATHS.search,
        { query: "archive probe", driveId: null },
        contextJson.search.decode,
      );
      expect(search.status).toBe(403);

      env.allowDrive("user_alice", env.billing.id);
      env.revokeDuringNextItemRead("user_alice", env.billing.id);
      const item = yield* env.call(
        reader,
        CONTEXT_PATHS.thread,
        {
          threadId: "archived-search-thread",
          itemId: "archived-search-item",
          projectId: env.billing.projectId,
        },
        contextJson.thread.decode,
      );
      expect(item.status).toBe(403);
    }),
  );

  it.effect("keeps drive-history commits and full-turn reads available", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const reader = { ...env.reader, driveId: env.billing.id };
      const found = yield* search(
        env,
        "In Billing we implemented a dark mode toggle",
        env.billing.id,
        reader,
      );
      const commit = found.driveHits.find((hit) => hit.kind === "commit");
      expect(commit).toMatchObject({
        commit: env.toggle,
        parent: env.first,
        files: ["theme/darkMode.ts"],
      });

      const diff = (yield* env.call(
        reader,
        CONTEXT_PATHS.diff,
        { driveId: env.billing.id, from: env.first, to: env.toggle },
        contextJson.diff.decode,
      )).body!;
      expect(diff._tag === "diff" && diff.patch).toContain("+export const darkMode");

      const opened = (yield* env.call(
        reader,
        CONTEXT_PATHS.thread,
        { threadId: env.toggleThread, turn: null },
        contextJson.thread.decode,
      )).body as ThreadResult;
      expect(opened).toMatchObject({ _tag: "thread", driveId: env.billing.id });
      expect(opened._tag === "thread" && opened.turns[0]?.messages[0]?.text).toBe(
        "Add a dark mode toggle to the settings",
      );
    }),
  );

  it.effect("finds others' unreconciled work, without naming their threads", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const reader = { ...env.reader, driveId: env.billing.id };
      const found = yield* search(env, "invoices export", null, reader);
      expect(found.driveHits).toContainEqual(
        expect.objectContaining({
          kind: "work",
          threadId: "thread-bob-export",
          title: null,
          commit: env.exportWip,
          files: ["invoices/export.csv"],
        }),
      );
      // Bob's conversation stays his.
      const opened = yield* env.call(
        reader,
        CONTEXT_PATHS.thread,
        { threadId: "thread-bob-export", turn: null },
        contextJson.thread.decode,
      );
      expect(opened.body).toEqual({ _tag: "not_found" });
    }),
  );

  it.effect("credits unreconciled work only with its own files, not main's it merged in", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const { git, cloud, billing, toggle } = env;
      // Bob's thread opens the drive at today's main...
      const late = {
        threadId: "thread-bob-late",
        userId: "user_bob",
        generation: 1,
        live: true,
        packsAfter: 0,
      };
      yield* launch(env.bob, ThreadId.make(late.threadId), billing.projectId, "Prepare Q3 reports");
      yield* DriveDirectory.use((directory) => directory.forDrive(billing.id).open(late)).pipe(
        Effect.provide(cloud.drives.layer),
      );
      // ...another thread lands an audit log...
      git.git(["checkout", "-q", "-b", "audit", toggle]);
      git.write("audit/log.ts", "log\n");
      const audit = git.commit("Add an audit log");
      yield* save(cloud, {
        driveId: billing.id,
        threadId: "thread-audit",
        userId: "user_alice",
        head: audit,
        packed: git.pack([audit], [toggle]),
        land: true,
      });
      // ...and Bob's unfinished work merges it in before landing.
      git.git(["checkout", "-q", "-b", "late", toggle]);
      git.write("reports/q3.ts", "q3\n");
      git.commit("Q3 reports");
      git.git(["merge", "-q", "--no-edit", "audit"]);
      const merged = git.git(["rev-parse", "HEAD"]);
      yield* save(cloud, {
        driveId: billing.id,
        threadId: late.threadId,
        userId: late.userId,
        head: merged,
        packed: git.pack([merged], [audit, env.exportWip]),
        land: false,
      });
      const reader = { ...env.reader, driveId: billing.id };
      const found = yield* search(env, "q3 reports", null, reader);
      expect(found.driveHits).toContainEqual(
        expect.objectContaining({
          kind: "work",
          threadId: late.threadId,
          base: audit,
          files: ["reports/q3.ts"],
        }),
      );
      // The audit log is main's: it isn't evidence of Bob's work.
      const audit_ = yield* search(env, "audit log", null, reader);
      expect(audit_.driveHits.map((hit) => hit.kind)).toEqual(["commit"]);
    }),
  );

  it.effect("answers insufficient evidence instead of guessing", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const reader = { ...env.reader, driveId: env.billing.id };
      const weak = yield* search(env, "kubernetes autoscaler for dark nodes", null, reader);
      expect(weak.hits).toEqual([]);
      expect(weak.driveHits).toEqual([]);
      expect(weak.coverage.available).toBe(true);
      const empty = yield* search(env, "how did we implement it", null, reader);
      expect(empty.hits).toEqual([]);
      expect(empty.driveHits).toEqual([]);
      const main = yield* DriveDirectory.use((directory) =>
        directory.forDrive(env.billing.id).ref(MAIN_REF),
      ).pipe(Effect.provide(env.cloud.drives.layer));
      expect(main).toBe(env.toggle);
    }),
  );
});
