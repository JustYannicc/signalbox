import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  DRIVE_PATHS,
  driveJson,
  shortcutPacksPath,
} from "@signalbox/runner-protocol/DriveProtocol";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { SIGNALBOX_DRIVES_WS_METHODS, SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import * as RuntimeDriveShortcuts from "../drive/DriveShortcuts.ts";
import { threadRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { shortcutRoute } from "../drive/shortcutRoutes.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";
import * as UserDirectory from "./UserDirectory.ts";

/**
 * #142's cloud half: shortcuts added and removed through the RPCs the web
 * client makes, and what a thread's machine may read of their targets.
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

type Cloud = ReturnType<typeof makeMemoryCloud>;

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
  return {
    cloud,
    alice: yield* clientOf(PEOPLE[0]),
    bob: yield* clientOf(PEOPLE[1]),
    carol: yield* clientOf(PEOPLE[2]),
  };
});

/** Lands `files` on `driveId`'s main, as a thread's machine would. */
const land = (cloud: Cloud, driveId: string, userId: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const git = makeRepo();
    repos.push(git);
    for (const [file, text] of Object.entries(files)) git.write(file, text);
    const head = git.commit("Files");
    const packed = git.pack([head]);
    const threadId = `thread-${driveId.replaceAll("/", "-")}`;
    expect((yield* uploadPack({ driveId, threadId, ...packed }))._tag).toBe("ok");
    const drive = (yield* DriveDirectory).forDrive(driveId);
    const writer = { threadId, userId, generation: 1, live: true, packsAfter: 0 };
    const opened = yield* drive.open(writer);
    if (opened._tag !== "ok") return yield* Effect.die(opened);
    yield* drive.updateRefs(writer, [
      { name: threadRef(threadId), old: opened.refs.thread, new: head },
    ]);
    const landed = yield* drive.reconcile(writer, {
      expectedMain: opened.refs.main,
      newMain: head,
    });
    expect(landed._tag).toBe("ok");
    return { git, head };
  }).pipe(Effect.provide(cloud.drives.layer));

/** What a thread's machine gets asking the drive API, as `userId` working in `driveId`. */
const machine = (cloud: Cloud, userId: string, driveId: string, threadId?: string) => {
  const call = (request: Request) =>
    shortcutRoute(
      { userId, driveId, ...(threadId === undefined ? {} : { threadId }) },
      request,
    ).pipe(
      Effect.provide(
        RuntimeDriveShortcuts.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              cloud.drives.layer,
              Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory),
            ),
          ),
        ),
      ),
    );
  return {
    list: Effect.gen(function* () {
      const response = yield* call(
        new Request(`http://cloud${DRIVE_PATHS.shortcuts}`, {
          method: "POST",
          body: driveJson.shortcutsRequest.encode({ have: {} }),
        }),
      );
      expect(response.status).toBe(200);
      return driveJson.shortcuts.decode(yield* Effect.promise(() => response.text())).shortcuts;
    }),
    pack: (target: string, name: string) =>
      Effect.map(
        call(new Request(`http://cloud${shortcutPacksPath(target)}/${name}.pack`)),
        (response) => response.status,
      ),
  };
};

describe("drive shortcuts (#142)", () => {
  it.effect(
    "forks keep shortcut paths and commits while current access remains authoritative",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob } = yield* setup;
        const design = yield* bob[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: ACME,
          name: "Design",
        });
        yield* bob[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "alice@acme.test",
          role: "viewer",
        });
        const target = yield* land(cloud, design.id, "user_bob", { "spec.md": "Version one\n" });
        const own = "my/personal/user_alice";
        const source = yield* land(cloud, own, "user_alice", { "work.md": "Uses version one\n" });
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
          driveId: SignalboxDriveId.make(own),
          path: "design",
          target: design.id,
        });
        const threadId = `thread-${own.replaceAll("/", "-")}`;
        const views = {
          shortcuts: [{ path: "design", target: design.id, commit: target.head }],
          context: null,
        };
        const record = {
          runId: "run-uses-v1",
          turnId: "run-uses-v1",
          commit: source.head,
          start: null,
          views,
        };
        source.git.git([
          "notes",
          "--ref=signalbox/checkpoints",
          "add",
          "-m",
          JSON.stringify(record),
          source.head,
        ]);
        const notes = source.git.git(["rev-parse", "refs/notes/signalbox/checkpoints"]);
        yield* uploadPack({
          driveId: own,
          threadId,
          ...source.git.pack([notes], [source.head]),
        }).pipe(Effect.provide(cloud.drives.layer));
        const handle = cloud.drives.apiFor(own);
        expect(
          (yield* Effect.promise(() =>
            handle.recordCheckpoint(
              { threadId, userId: "user_alice", generation: 1, live: true, packsAfter: 0 },
              { ...record, notes },
            ),
          ))._tag,
        ).toBe("ok");
        expect(
          (yield* Effect.promise(() =>
            handle.forkCheckpoint("user_alice", {
              sourceThreadId: threadId,
              runId: record.runId,
              threadId: "child-uses-v1",
              operationId: "fork-uses-v1",
            }),
          ))._tag,
        ).toBe("ok");

        target.git.write("spec.md", "Version two\n");
        const latest = target.git.commit("Version two");
        yield* uploadPack({
          driveId: design.id,
          threadId: "target-update",
          ...target.git.pack([latest], [target.head]),
        }).pipe(Effect.provide(cloud.drives.layer));
        const targetHandle = cloud.drives.apiFor(design.id);
        const writer = {
          threadId: "target-update",
          userId: "user_bob",
          generation: 1,
          live: true,
          packsAfter: 0,
        };
        yield* Effect.promise(() => targetHandle.open(writer));
        yield* Effect.promise(() =>
          targetHandle.updateRefs(writer, [
            { name: threadRef(writer.threadId), old: target.head, new: latest },
          ]),
        );
        yield* Effect.promise(() =>
          targetHandle.reconcile(writer, { expectedMain: target.head, newMain: latest }),
        );
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.removeShortcut]({
          driveId: SignalboxDriveId.make(own),
          path: "design",
        });
        const pinned = machine(cloud, "user_alice", own, "child-uses-v1");
        expect(yield* machine(cloud, "user_alice", own).list).toEqual([]);
        expect(yield* pinned.list).toMatchObject([
          { path: "design", target: design.id, main: target.head, pinned: true, readable: true },
        ]);
        const [pack] = yield* Effect.promise(() => targetHandle.refs(null)).pipe(
          Effect.map((refs) => refs.packs),
        );
        expect(yield* pinned.pack(design.id, pack!.name)).toBe(200);

        yield* bob[SIGNALBOX_DRIVES_WS_METHODS.unshare]({
          driveId: design.id,
          userId: "user_alice",
        });
        expect(yield* pinned.list).toMatchObject([
          { path: "design", main: null, readable: false, packs: [] },
        ]);
        expect(yield* pinned.pack(design.id, pack!.name)).toBe(403);
      }),
  );

  it.effect(
    "a shortcut shows another drive at a new folder; the rules keep the drive's own files safe",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob, carol } = yield* setup;
        const design = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: ACME,
          name: "Design",
        });
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: design.id,
          email: "bob@acme.test",
          role: "viewer",
        });
        const myDrive = SignalboxDriveId.make("my/org_acme/user_alice");
        yield* land(cloud, myDrive, "user_alice", { "notes.md": "hi\n" });

        const added = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
          driveId: myDrive,
          path: "team/design",
          target: design.id,
        });
        expect(added).toEqual({ path: "team/design", target: design.id, name: "Design" });
        expect(yield* alice[SIGNALBOX_DRIVES_WS_METHODS.shortcuts]({ driveId: myDrive })).toEqual({
          shortcuts: [added],
        });

        const refused = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
          Effect.map(Effect.flip(effect), (error) => error.message);
        const add = (path: string, target = design.id, client = alice, driveId = myDrive) =>
          refused(client[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({ driveId, path, target }));
        expect(yield* add("team/design")).toBe("team/design is already a shortcut.");
        expect(yield* add("team/design/sub")).toBe(
          "team/design/sub would overlap the shortcut at team/design.",
        );
        expect(yield* add("team")).toBe("team would overlap the shortcut at team/design.");
        expect(yield* add("notes.md")).toBe(
          "notes.md already exists in this drive. Pick another name.",
        );
        // Not under a file either: only folders above a shortcut.
        expect(yield* add("notes.md/inside")).toBe(
          "notes.md/inside already exists in this drive. Pick another name.",
        );
        expect(yield* add("../up")).toBe("Choose a folder name.");
        expect(yield* add("self", myDrive)).toBe("A drive can't hold a shortcut to itself.");
        // Bob only views Design: he can't change it.
        expect(yield* add("mine", myDrive, bob, design.id)).toBe("You can't change this drive.");
        // Carol can't open Design, so she can't show it anywhere.
        expect(
          yield* add("design", design.id, carol, SignalboxDriveId.make("my/personal/user_carol")),
        ).toBe("You don't have access to the drive you picked.");

        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.removeShortcut]({
          driveId: myDrive,
          path: "team/design",
        });
        expect(yield* alice[SIGNALBOX_DRIVES_WS_METHODS.shortcuts]({ driveId: myDrive })).toEqual({
          shortcuts: [],
        });
        expect(
          yield* refused(
            alice[SIGNALBOX_DRIVES_WS_METHODS.removeShortcut]({
              driveId: myDrive,
              path: "team/design",
            }),
          ),
        ).toBe("team/design isn't a shortcut.");
      }).pipe(Effect.scoped),
  );

  it.effect("a thread's machine reads a target only while its user can open it", () =>
    Effect.gen(function* () {
      const { cloud, alice, bob } = yield* setup;
      const design = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
        contextId: ACME,
        name: "Design",
      });
      yield* land(cloud, design.id, "user_alice", { "AGENTS.md": "Design rules\n" });
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
        driveId: design.id,
        email: "bob@acme.test",
        role: "viewer",
      });
      const bobsDrive = SignalboxDriveId.make("my/org_acme/user_bob");
      yield* bob[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
        driveId: bobsDrive,
        path: "design",
        target: design.id,
      });
      const bobs = machine(cloud, "user_bob", bobsDrive);

      const [listed] = yield* bobs.list;
      expect(listed).toMatchObject({ path: "design", target: design.id, readable: true });
      expect(listed!.main).not.toBeNull();
      expect(listed!.packs).toHaveLength(1);
      expect(yield* bobs.pack(design.id, listed!.packs[0]!.name)).toBe(200);
      // Only targets of the drive's own shortcuts.
      expect(yield* bobs.pack("shared/org_acme/other", listed!.packs[0]!.name)).toBe(403);

      // Removed from Design: the next listing takes the mount down, and its packs stop at once.
      const people = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.members]({ driveId: design.id });
      const bobMember = people.members.find((member) => member.email === "bob@acme.test")!;
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.unshare]({
        driveId: design.id,
        userId: bobMember.userId,
      });
      expect(yield* bobs.list).toEqual([
        {
          path: "design",
          target: design.id,
          readable: false,
          main: null,
          packs: [],
          shallow: [],
          remote: null,
        },
      ]);
      expect(yield* bobs.pack(design.id, listed!.packs[0]!.name)).toBe(403);
    }).pipe(Effect.scoped),
  );
});
