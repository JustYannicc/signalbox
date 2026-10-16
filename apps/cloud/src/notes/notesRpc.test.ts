import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import { SIGNALBOX_FOLDERS_WS_METHODS } from "@t3tools/contracts/signalboxFolders";
import { SIGNALBOX_NOTES_WS_METHODS } from "@t3tools/contracts/signalboxNotes";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import * as NoteReader from "./NoteReader.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";

describe("notes over the user's socket", () => {
  it.effect("writes a note, reads it, and starts its offer as a task filed in its folder", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud({
        noteReader: NoteReader.layerTest((request) =>
          Option.some({
            _tag: "offer",
            reader: request.reader,
            meaning: "The invoices need sending.",
            action: "Start a task to send them.",
            dismissed: false,
          }),
        ),
      });
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
            CloudRpc.layerScopeAuthorization([
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]),
          ).pipe(Layer.provide(cloud.layerFor(userId))),
        ),
      );
      const folders = yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.create]({
        name: "Admin",
        parentId: null,
      });
      const admin = folders.folders[0]!.id;

      yield* rpc[SIGNALBOX_NOTES_WS_METHODS.create]({
        home: { _tag: "folder", folderId: admin },
        text: "invoices!!",
      });
      const read = yield* rpc[SIGNALBOX_NOTES_WS_METHODS.subscribe]({}).pipe(
        Stream.filter((snapshot) => snapshot.notes[0]?.reading !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const note = read.notes[0]!;

      const { threadId } = yield* rpc[SIGNALBOX_NOTES_WS_METHODS.accept]({
        id: note.id,
        modelSelection: scriptedModelSelection,
      });
      yield* cloud.settle;
      const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
      expect(projection.thread).toMatchObject({
        title: "The invoices need sending.",
        projectId: Environment.SCRATCH_PROJECT_ID,
      });
      expect(projection.messages[0]?.text).toBe(
        "invoices!!\n\nFrom my notes. My assistant read it as: The invoices need sending. Start a task to send them.",
      );
      const homes = (yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.subscribe]({}).pipe(
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )).threadHomes;
      expect(homes).toContainEqual({ threadId, folderId: admin });
    }),
  );
});
