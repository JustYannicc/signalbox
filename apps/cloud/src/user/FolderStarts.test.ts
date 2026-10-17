import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId, SIGNALBOX_FOLDERS_WS_METHODS } from "@t3tools/contracts/signalboxFolders";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { myDriveId } from "../drive/driveAccess.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { threadRef } from "../drive/DriveStore.ts";
import { makeMemoryCloud } from "../testing.ts";
import { driveOfProject } from "./contextProjects.ts";
import * as CloudRpc from "./rpc.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const USER = "user_alice";
const EMAIL = "alice@acme.test";
const ACME = SignalboxContextId.make("org_acme");
const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const created = makeRepo();
  repos.push(created);
  return created;
};

afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const connect = (cloud: ReturnType<typeof makeMemoryCloud>) =>
  RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId: USER, sid: "test-session" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(USER))),
    ),
  );

const drive = (cloud: ReturnType<typeof makeMemoryCloud>, driveId: string) =>
  DriveDirectory.use((directory) => Effect.succeed(directory.forDrive(driveId))).pipe(
    Effect.provide(cloud.drives.layer),
  );

const land = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  input: {
    readonly driveId: string;
    readonly threadId: string;
    readonly head: string;
    readonly packed: ReturnType<ReturnType<typeof makeRepo>["pack"]>;
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
    const target = yield* DriveDirectory.use((directory) =>
      Effect.succeed(directory.forDrive(input.driveId)),
    );
    const writer = {
      threadId: input.threadId,
      userId: USER,
      generation: 1,
      live: true,
      packsAfter: 0,
    };
    const opened = yield* target.open(writer);
    if (opened._tag !== "ok") throw new Error("could not open test drive");
    const branch = yield* target.updateRefs(writer, [
      { name: threadRef(input.threadId), old: opened.refs.thread, new: input.head },
    ]);
    if (branch._tag !== "ok") throw new Error("could not update test branch");
    const landed = yield* target.reconcile(writer, {
      expectedMain: opened.refs.main,
      newMain: input.head,
    });
    if (landed._tag !== "ok") throw new Error("could not advance test drive");
  }).pipe(Effect.provide(cloud.drives.layer));

describe("starting a folder from existing work", () => {
  it.effect("shares the source history and retries from its recorded head", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const user = cloud.userDirectory.forUser(USER);
      yield* user.recordSignIn({ id: USER, email: EMAIL, firstName: "Alice" });
      yield* user.syncOrganizations([{ id: ACME, name: "Acme" }]);
      const alice = yield* connect(cloud);
      const created = yield* alice[SIGNALBOX_FOLDERS_WS_METHODS.create]({
        name: "Research",
        parentId: null,
        ownerId: ACME,
      });
      const source = created.folders.find((folder) => folder.name === "Research")!;
      const sourceDriveId = myDriveId(ACME, USER);
      const git = repo();
      git.write("brief.md", "first version\n");
      const firstHead = git.commit("Write the brief");
      yield* land(cloud, {
        driveId: sourceDriveId,
        threadId: "thread-source",
        head: firstHead,
        packed: git.pack([firstHead]),
      });
      const originalDrive = yield* drive(cloud, sourceDriveId);
      const originalRefs = yield* originalDrive.refs(null);

      const newFolderId = FolderId.make("research-copy");
      const started = yield* alice[SIGNALBOX_FOLDERS_WS_METHODS.startFrom]({
        id: source.id,
        newFolderId,
      });
      const copy = started.folders.find((folder) => folder.id === newFolderId)!;
      expect(copy).toMatchObject({
        name: "Research (copy)",
        ownerId: ACME,
        parentId: null,
        origin: {
          folderId: source.id,
          name: "Research",
          driveId: sourceDriveId,
          head: firstHead,
        },
      });
      const destinationDriveId = driveOfProject(copy.files!.projectId, USER)!;
      const destinationDrive = yield* drive(cloud, destinationDriveId);
      const destinationRefs = yield* destinationDrive.refs(null);
      expect(destinationRefs.main).toBe(firstHead);
      expect(yield* destinationDrive.packStorage(destinationRefs.packs[0]!.name)).toBe(
        sourceDriveId,
      );
      expect(yield* destinationDrive.historyOrigin(USER)).toEqual({
        sourceDriveId,
        head: firstHead,
      });
      expect(yield* originalDrive.refs(null)).toEqual(originalRefs);

      git.write("brief.md", "second version\n");
      const secondHead = git.commit("Revise the brief");
      yield* land(cloud, {
        driveId: sourceDriveId,
        threadId: "thread-source",
        head: secondHead,
        packed: git.pack([secondHead]),
      });
      yield* alice[SIGNALBOX_FOLDERS_WS_METHODS.delete]({ id: newFolderId });

      // A crash after importing history leaves the origin and reservation behind.
      // The retry must finish from that exact head even after the source advances.
      const retried = yield* alice[SIGNALBOX_FOLDERS_WS_METHODS.startFrom]({
        id: source.id,
        newFolderId,
      });
      const restored = retried.folders.find((folder) => folder.id === newFolderId)!;
      expect(restored.origin?.head).toBe(firstHead);
      expect((yield* destinationDrive.refs(null)).main).toBe(firstHead);
      expect((yield* originalDrive.refs(null)).main).toBe(secondHead);
      expect(yield* destinationDrive.historyOrigin(USER)).toEqual({
        sourceDriveId,
        head: firstHead,
      });
    }).pipe(Effect.scoped),
  );
});
