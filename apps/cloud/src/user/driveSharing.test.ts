// @effect-diagnostics nodeBuiltinImport:off - reads a split drive back with real git.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { SIGNALBOX_DRIVES_WS_METHODS, SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { makeDriveReader } from "../drive/DriveReader.ts";
import { MAIN_REF, threadRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "./rpc.ts";

/**
 * #140 end to end, through the same RPCs the web client makes: a private
 * thread in a shared drive, a folder shared out of My Drive, and removal
 * cutting access everywhere at once. Files land the way a thread's machine
 * lands them: a pack, the thread's branch, then `main`.
 */

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const ACME = SignalboxContextId.make("org_acme");
const PEOPLE = [
  { userId: "user_alice", email: "alice@acme.test", name: "Alice", organizations: [ACME] },
  { userId: "user_bob", email: "bob@acme.test", name: "Bob", organizations: [ACME] },
  { userId: "user_carol", email: "carol@example.test", name: "Carol", organizations: [] },
] as const;

const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const created = makeRepo();
  repos.push(created);
  return created;
};
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

type Cloud = ReturnType<typeof makeMemoryCloud>;

/** Everyone signed in, in their organizations, each with a client of their own object. */
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
  return {
    cloud,
    alice: yield* clientOf(PEOPLE[0]),
    bob: yield* clientOf(PEOPLE[1]),
    carol: yield* clientOf(PEOPLE[2]),
  };
});

type Client = Effect.Success<typeof setup>["alice"];

/** What a thread's machine does at the end of a turn: upload, move its branch, fast-forward `main`. */
const land = (
  cloud: Cloud,
  input: {
    readonly driveId: string;
    readonly threadId: string;
    readonly userId: string;
    readonly head: string;
    readonly packed: {
      readonly pack: Uint8Array<ArrayBuffer>;
      readonly idx: Uint8Array<ArrayBuffer>;
    };
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
    const writer = {
      threadId: input.threadId,
      userId: input.userId,
      generation: 1,
      live: true,
      packsAfter: 0,
    };
    const opened = yield* drive.open(writer);
    if (opened._tag !== "ok") return opened;
    const branch = yield* drive.updateRefs(writer, [
      { name: threadRef(input.threadId), old: opened.refs.thread, new: input.head },
    ]);
    if (branch._tag !== "ok") return branch;
    return yield* drive.reconcile(writer, { expectedMain: opened.refs.main, newMain: input.head });
  }).pipe(Effect.provide(cloud.drives.layer));

const launchIn = (client: Client, threadId: ThreadId, projectId: ProjectId) =>
  client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make(`launch-${threadId}`),
    threadId,
    projectId,
    title: "Work",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make(`m-${threadId}`), text: "Hi", attachments: [] },
  });

const drivesOf = (client: Client) =>
  client[SIGNALBOX_DRIVES_WS_METHODS.subscribe]({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([snapshot]) => snapshot?.drives ?? []),
  );

const shellOf = (client: Client) =>
  client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([item]) => (item?.kind === "snapshot" ? item.snapshot : null)),
  );

const paths = (client: Client, cwd: string, directoryPath = "") =>
  Effect.map(client[WS_METHODS.projectsListEntries]({ cwd, directoryPath }), (listed) =>
    listed.entries.map((entry) => entry.path),
  );

const readText = (client: Client, cwd: string, relativePath: string) =>
  Effect.map(client[WS_METHODS.projectsReadFile]({ cwd, relativePath }), (file) => file.contents);

const driveRoot = (driveId: string) => `/drives/${driveId}`;

describe("drive sharing (#140)", () => {
  it.effect(
    "a private thread in a shared drive lands its files there, its conversation stays private",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob } = yield* setup;
        const design = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: ACME,
          name: "Design",
        });
        expect(design).toMatchObject({ kind: "shared", role: "manager", contextId: ACME });
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "bob@acme.test",
          role: "contributor",
        });
        // Bob's sidebar lists it under Acme, as a project of its own.
        expect(yield* drivesOf(bob)).toContainEqual(
          expect.objectContaining({ id: design.id, role: "contributor", sharedBy: "Alice" }),
        );
        const bobShell = yield* shellOf(bob);
        expect(bobShell?.projects.map((project) => project.title)).toContain("Design");

        const threadId = ThreadId.make("thread-alice-design");
        yield* launchIn(alice, threadId, design.projectId);
        expect(yield* cloud.threadOwner(threadId)).toEqual({
          userId: "user_alice",
          contextId: ACME,
          driveId: design.id,
        });

        const git = repo();
        git.write("brief.md", "Make it pop\n");
        const head = git.commit("Write the brief");
        const landed = yield* land(cloud, {
          driveId: design.id,
          threadId,
          userId: "user_alice",
          head,
          packed: git.pack([head]),
        });
        expect(landed._tag).toBe("ok");

        // The files are the drive's: Bob reads them.
        expect(yield* paths(bob, driveRoot(design.id))).toEqual(["brief.md"]);
        expect(yield* readText(bob, driveRoot(design.id), "brief.md")).toBe("Make it pop\n");
        // The conversation is Alice's alone.
        yield* cloud.settle;
        const hidden = yield* bob[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId,
        }).pipe(Effect.flip);
        expect(hidden.message).toBe("Thread not found.");
        expect((yield* shellOf(bob))?.threads.map((thread) => thread.id)).not.toContain(threadId);
        expect((yield* shellOf(alice))?.threads.map((thread) => thread.id)).toContain(threadId);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "sharing a folder from My Drive shows the recipient only that folder and its history",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob, carol } = yield* setup;
        const myDrive = SignalboxDriveId.make("my/personal/user_alice");
        const git = repo();
        git.write("notes/plan.md", "v1\n");
        git.write("secret.md", "hush\n");
        git.commit("Start notes");
        git.write("secret.md", "hush, again\n");
        git.commit("Only secrets");
        git.write("notes/plan.md", "v2\n");
        git.write("notes/todo.md", "ship\n");
        const head = git.commit("More notes");
        yield* land(cloud, {
          driveId: myDrive,
          threadId: "thread-alice-notes",
          userId: "user_alice",
          head,
          packed: git.pack([head]),
        });

        const folder = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.shareFolder]({
          driveId: myDrive,
          path: "notes",
          email: "carol@example.test",
          role: "viewer",
        });
        expect(folder).toMatchObject({ kind: "folder", name: "notes", role: "owner" });

        // Carol sees the folder in Shared with me, and only what's in it.
        expect(yield* drivesOf(carol)).toContainEqual(
          expect.objectContaining({ id: folder.id, role: "viewer", sharedBy: "Alice" }),
        );
        expect((yield* paths(carol, driveRoot(folder.id))).toSorted()).toEqual([
          "plan.md",
          "todo.md",
        ]);
        expect(yield* readText(carol, driveRoot(folder.id), "plan.md")).toBe("v2\n");
        expect(yield* paths(carol, driveRoot(myDrive))).toEqual([]);

        // Its history is the folder's alone, readable by plain git.
        const exported = repo();
        const drive = yield* DriveDirectory.use((directory) =>
          Effect.succeed(directory.forDrive(folder.id)),
        ).pipe(Effect.provide(cloud.drives.layer));
        const refs = yield* drive.refs(null);
        const packDir = NodePath.join(exported.dir, ".git", "objects", "pack");
        for (const pack of refs.packs) {
          for (const ext of ["pack", "idx"] as const) {
            const key = `${folder.id}/packs/pack-${pack.name}.${ext}`;
            const file = yield* Effect.promise(() => cloud.drives.bucket.get(key));
            const bytes = new Uint8Array(yield* Effect.promise(() => file!.arrayBuffer()));
            NodeFS.writeFileSync(NodePath.join(packDir, `pack-${pack.name}.${ext}`), bytes);
          }
        }
        exported.git(["update-ref", "refs/heads/main", refs.main!]);
        expect(exported.git(["log", "--format=%s", "main"]).split("\n")).toEqual([
          "More notes",
          "Start notes",
        ]);
        const objects = exported.git(["rev-list", "--objects", "--all"]);
        expect(objects).toContain("plan.md");
        expect(objects).not.toContain("secret.md");
        exported.git(["fsck", "--connectivity-only"]);

        // Alice sees no difference: the folder stays at its path, as a shortcut.
        const scratch = Environment.scratchProject.workspaceRoot;
        expect((yield* paths(alice, scratch)).toSorted()).toEqual(["notes", "secret.md"]);
        expect((yield* paths(alice, scratch, "notes")).toSorted()).toEqual([
          "notes/plan.md",
          "notes/todo.md",
        ]);
        expect(yield* readText(alice, scratch, "notes/plan.md")).toBe("v2\n");
        // My Drive itself no longer holds the folder.
        const mine = yield* makeDriveReader(myDrive).pipe(Effect.provide(cloud.drives.layer));
        const main = yield* mine.drive.ref(MAIN_REF);
        const root = yield* mine.tree(yield* mine.treeOf(main));
        expect(root.map((entry) => entry.name)).toEqual(["secret.md"]);

        // Sharing it again shares the same drive; nothing is split twice.
        const again = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.shareFolder]({
          driveId: myDrive,
          path: "notes",
          email: "bob@acme.test",
          role: "editor",
        });
        expect(again.id).toBe(folder.id);
        expect((yield* paths(bob, driveRoot(folder.id))).toSorted()).toEqual([
          "plan.md",
          "todo.md",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("removing someone from a shared drive cuts their access to it everywhere at once", () =>
    Effect.gen(function* () {
      const { cloud, alice, bob } = yield* setup;
      const design = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
        contextId: ACME,
        name: "Design",
      });
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
        driveId: design.id,
        email: "bob@acme.test",
        role: "contributor",
      });
      const threadId = ThreadId.make("thread-bob-design");
      yield* launchIn(bob, threadId, design.projectId);
      const git = repo();
      git.write("a.md", "a\n");
      const first = git.commit("First");
      const landWith = (head: string, packed: ReturnType<typeof git.pack>) =>
        land(cloud, { driveId: design.id, threadId, userId: "user_bob", head, packed });
      expect((yield* landWith(first, git.pack([first])))._tag).toBe("ok");

      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.unshare]({
        driveId: design.id,
        userId: "user_bob",
      });

      // Browsing, the sidebar, his threads' machines and new threads: all at once.
      expect(yield* paths(bob, driveRoot(design.id))).toEqual([]);
      expect((yield* drivesOf(bob)).map((drive) => drive.id)).not.toContain(design.id);
      expect(yield* cloud.userDirectory.forUser("user_bob").driveAccess(design.id)).toBeNull();
      git.write("b.md", "b\n");
      const second = git.commit("Second");
      expect(yield* landWith(second, git.pack([second], [first]))).toEqual({
        _tag: "refused",
        reason: "You no longer have access to change this drive.",
      });
      const late = yield* launchIn(bob, ThreadId.make("thread-bob-late"), design.projectId).pipe(
        Effect.flip,
      );
      expect(late._tag).toBe("OrchestrationV2ThreadLaunchError");
      // His own conversation stays his: a thread's visibility isn't the drive's.
      const projection = yield* bob[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
      expect(projection.thread.id).toBe(threadId);
      const diff = yield* bob[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
      }).pipe(Effect.flip);
      expect(diff.message).toBe("You don't have access to this drive's files.");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "leaving the organization cuts access to its drives and threads at once, and rejoining restores it",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob } = yield* setup;
        const design = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: ACME,
          name: "Design",
        });
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "bob@acme.test",
          role: "contributor",
        });
        const git = repo();
        git.write("a.md", "a\n");
        const head = git.commit("First");
        yield* land(cloud, {
          driveId: design.id,
          threadId: "thread-alice",
          userId: "user_alice",
          head,
          packed: git.pack([head]),
        });
        const threadId = ThreadId.make("thread-bob-acme");
        yield* launchIn(bob, threadId, design.projectId);
        yield* cloud.settle;

        // Bob has the thread open when he leaves.
        const caughtUp = yield* Deferred.make<void>();
        const open = yield* bob[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId,
          requestCompletionMarker: true,
        }).pipe(
          Stream.tap((item) =>
            item.kind === "synchronized" ? Deferred.succeed(caughtUp, undefined) : Effect.void,
          ),
          Stream.runDrain,
          Effect.flip,
          Effect.forkChild,
        );
        yield* Deferred.await(caughtUp);

        // What a WorkOS membership event leads to (`http/workosWebhook.ts`).
        const bobObject = cloud.userDirectory.forUser("user_bob");
        yield* bobObject.syncOrganizations([]);

        expect((yield* Fiber.join(open)).message).toBe("Thread not found.");
        const hidden = yield* bob[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId,
        }).pipe(Effect.flip);
        expect(hidden.message).toBe("Thread not found.");
        const send = yield* bob[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "message.dispatch",
          commandId: CommandId.make("send-after-leaving"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("m-after"),
          text: "Still here?",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
        }).pipe(Effect.flip);
        expect(send.message).toBe("Thread not found.");
        const shell = yield* shellOf(bob);
        expect(shell?.threads).toEqual([]);
        expect(shell?.projects.map((project) => project.title)).toEqual(["Scratch"]);
        // Still a member in the drive's own list, but the organization's files are out of reach.
        const drive = yield* DriveDirectory.use((directory) =>
          Effect.succeed(directory.forDrive(design.id)),
        ).pipe(Effect.provide(cloud.drives.layer));
        expect(yield* drive.role("user_bob")).toBe("contributor");
        expect(yield* paths(bob, driveRoot(design.id))).toEqual([]);
        expect(yield* bobObject.driveAccess(design.id)).toBeNull();
        expect(yield* bobObject.driveAccess("my/org_acme/user_bob")).toBeNull();

        // Rejoining brings it all back.
        yield* bobObject.syncOrganizations([{ id: ACME, name: "Acme" }]);
        expect(yield* paths(bob, driveRoot(design.id))).toEqual(["a.md"]);
        const back = yield* bob[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
        expect(back.thread.id).toBe(threadId);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "only managers share, organizations' files stay inside them, and a drive keeps a manager",
    () =>
      Effect.gen(function* () {
        const { alice, bob, carol } = yield* setup;
        const design = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: ACME,
          name: "Design",
        });
        const outsider = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "carol@example.test",
          role: "viewer",
        }).pipe(Effect.flip);
        expect(outsider.message).toBe("carol@example.test isn't in Acme.");
        const nobody = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "dave@example.test",
          role: "viewer",
        }).pipe(Effect.flip);
        expect(nobody.message).toBe("Nobody with dave@example.test uses Signalbox yet.");
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "bob@acme.test",
          role: "viewer",
        });
        const notManager = yield* bob[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "alice@acme.test",
          role: "viewer",
        }).pipe(Effect.flip);
        expect(notManager.message).toBe("Only the drive's managers can share it.");
        // A viewer reads the drive but starts no threads in it.
        const viewing = yield* launchIn(bob, ThreadId.make("thread-viewer"), design.projectId).pipe(
          Effect.flip,
        );
        expect(viewing._tag).toBe("OrchestrationV2ThreadLaunchError");
        const lastManager = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "alice@acme.test",
          role: "viewer",
        }).pipe(Effect.flip);
        expect(lastManager.message).toBe("A drive needs at least one manager.");
        const members = yield* bob[SIGNALBOX_DRIVES_WS_METHODS.members]({ driveId: design.id });
        expect(members.members.map((member) => [member.email, member.role])).toEqual([
          ["alice@acme.test", "manager"],
          ["bob@acme.test", "viewer"],
        ]);
        const personalDrive = yield* carol[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: SignalboxContextId.make("personal"),
          name: "Mine",
        }).pipe(Effect.flip);
        expect(personalDrive.message).toBe("Shared drives belong to a work organization.");
      }).pipe(Effect.scoped),
  );
});
