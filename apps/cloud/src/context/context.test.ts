import {
  CONTEXT_PATHS,
  contextJson,
  type SearchResult,
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
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { SIGNALBOX_DRIVES_WS_METHODS } from "@t3tools/contracts/signalboxDrives";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { MAIN_REF, threadRef, wipRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { makeMemoryCloud } from "../testing.ts";
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
  const clientOf = (person: (typeof PEOPLE)[number]) =>
    Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(person.userId);
      yield* user.recordSignIn({ id: person.userId, email: person.email, firstName: person.name });
      yield* user.syncOrganizations(person.organizations.map((id) => ({ id, name: "Acme" })));
      return yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, userId: person.userId }),
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
        Layer.succeed(UserDirectory, cloud.userDirectory),
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
  return { cloud, alice, bob, call };
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
    (answer) => answer.body as SearchResult,
  );

describe("context API (#141)", () => {
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
      expect((yield* search(env, "dark mode toggle", null, carol))._tag).toBe(
        "insufficient_evidence",
      );
    }),
  );

  it.effect("finds the thread and the commit that built something, and its diff", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const found = yield* search(
        env,
        "In Billing we implemented a dark mode toggle",
        env.billing.id,
      );
      expect(found._tag).toBe("found");
      if (found._tag !== "found") return;
      expect(found.terms).toEqual(["billing", "dark", "mode", "toggle"]);
      const kinds = found.hits.map((hit) => hit.kind);
      expect(kinds).toContain("thread");
      expect(kinds).toContain("commit");
      const thread = found.hits.find((hit) => hit.kind === "thread")!;
      // The current thread asks the question; it is never its own answer.
      expect(thread).toMatchObject({ threadId: env.toggleThread, driveId: env.billing.id });
      const commit = found.hits.find((hit) => hit.kind === "commit");
      expect(commit).toMatchObject({
        commit: env.toggle,
        parent: env.first,
        files: ["theme/darkMode.ts"],
      });

      const diff = (yield* env.call(
        env.reader,
        CONTEXT_PATHS.diff,
        { driveId: env.billing.id, from: env.first, to: env.toggle },
        contextJson.diff.decode,
      )).body!;
      expect(diff._tag === "diff" && diff.patch).toContain("+export const darkMode");

      const opened = (yield* env.call(
        env.reader,
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
      const found = yield* search(env, "invoices export");
      expect(found).toMatchObject({
        _tag: "found",
        hits: [
          {
            kind: "work",
            threadId: "thread-bob-export",
            title: null,
            commit: env.exportWip,
            files: ["invoices/export.csv"],
          },
        ],
      });
      // Bob's conversation stays his.
      const opened = yield* env.call(
        env.reader,
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
      const found = yield* search(env, "q3 reports");
      expect(found).toMatchObject({
        _tag: "found",
        hits: [{ kind: "work", threadId: late.threadId, base: audit, files: ["reports/q3.ts"] }],
      });
      // The audit log is main's: it isn't evidence of Bob's work.
      const audit_ = yield* search(env, "audit log");
      expect(audit_._tag === "found" && audit_.hits.map((hit) => hit.kind)).toEqual(["commit"]);
    }),
  );

  it.effect("answers insufficient evidence instead of guessing", () =>
    Effect.gen(function* () {
      const env = yield* world;
      const weak = yield* search(env, "kubernetes autoscaler for dark nodes");
      expect(weak._tag).toBe("insufficient_evidence");
      expect(weak.searched).toMatchObject({ threads: 1, drives: 3 });
      const empty = yield* search(env, "how did we implement it");
      expect(empty._tag === "insufficient_evidence" && empty.reason).toMatch(/no words/);
      const main = yield* DriveDirectory.use((directory) =>
        directory.forDrive(env.billing.id).ref(MAIN_REF),
      ).pipe(Effect.provide(env.cloud.drives.layer));
      expect(main).toBe(env.toggle);
    }),
  );
});
