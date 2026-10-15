import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import {
  type ChatAttachment,
  ChatAttachmentId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Environment from "../environment.ts";
import { layerAttachments, layerThreadObject, makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as ThreadRunner from "../thread/runner/ThreadRunner.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as ThreadEngine from "../thread/ThreadEngine.ts";
import { threadSegment } from "./attachmentIds.ts";
import { makeMemoryObjects } from "./attachmentTesting.ts";
import { attachmentKey, CloudAttachments } from "./CloudAttachments.ts";
import { serveRunnerAttachments } from "./runnerAttachments.ts";

const userId = "user_1";
const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const body = (bytes: Uint8Array) => new Blob([bytes.slice()]).stream();
const tokenOf = (relativeUrl: string) => relativeUrl.split("/").at(-1) ?? "";
const bytesOf = (stream: ReadableStream<Uint8Array>) =>
  Effect.promise(async () => new Uint8Array(await new Response(stream).arrayBuffer()));

/** Uploads `bytes` as `userId`, the way a client does: mint the URL, then POST to it. */
const upload = (
  service: CloudAttachments["Service"],
  owner: string,
  bytes: Uint8Array,
  input: { readonly type?: "file"; readonly name?: string; readonly mimeType?: string } = {},
) =>
  Effect.gen(function* () {
    const minted = yield* service.issueUpload(owner, {
      ...(input.type === undefined ? {} : { type: input.type }),
      name: input.name ?? "shot.png",
      mimeType: (input.mimeType ?? "image/png") as "image/png",
      sizeBytes: bytes.length,
    });
    const outcome = yield* service.storeUpload(
      tokenOf(minted.relativeUrl),
      body(bytes),
      bytes.length,
    );
    expect(outcome._tag).toBe("stored");
    const attachment: ChatAttachment =
      input.type === "file"
        ? {
            type: "file",
            id: ChatAttachmentId.make(minted.attachmentId),
            name: input.name ?? "notes.txt",
            mimeType: input.mimeType ?? "text/plain",
            sizeBytes: bytes.length,
          }
        : {
            type: "image",
            id: ChatAttachmentId.make(minted.attachmentId),
            name: input.name ?? "shot.png",
            mimeType: input.mimeType ?? "image/png",
            sizeBytes: bytes.length,
          };
    return attachment;
  });

const withService = <A, E>(
  use: (
    service: CloudAttachments["Service"],
    objects: ReturnType<typeof makeMemoryObjects>,
  ) => Effect.Effect<A, E>,
) => {
  const objects = makeMemoryObjects();
  return CloudAttachments.use((service) => use(service, objects)).pipe(
    Effect.provide(layerAttachments(objects)),
  );
};

describe("CloudAttachments", () => {
  it.effect("stores an upload only with exactly the bytes its URL promised", () =>
    withService((service, objects) =>
      Effect.gen(function* () {
        const minted = yield* service.issueUpload(userId, {
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: PNG.length,
        });
        expect(minted.attachmentId).toMatch(/^pending-[0-9a-f-]{36}$/);
        const token = tokenOf(minted.relativeUrl);

        const wrongSize = { _tag: "wrong-size", sizeBytes: PNG.length };
        expect(yield* service.storeUpload(token, body(PNG), PNG.length + 1)).toEqual(wrongSize);
        expect(yield* service.storeUpload(token, body(PNG.subarray(1)), null)).toEqual(wrongSize);
        expect(objects.keys()).toEqual([]);
        expect((yield* service.storeUpload("made.up", body(PNG), PNG.length))._tag).toBe("unknown");

        expect((yield* service.storeUpload(token, body(PNG), PNG.length))._tag).toBe("stored");
        expect(objects.keys()).toEqual([attachmentKey("", minted.attachmentId)]);
      }),
    ),
  );

  it.effect("claims a pending upload into the thread, for its uploader only", () =>
    withService((service, objects) =>
      Effect.gen(function* () {
        const threadId = "thread:abc";
        const shot = yield* upload(service, userId, PNG);

        const claim = (owner: string, thread: string, attachments: ReadonlyArray<ChatAttachment>) =>
          service.claim({ userId: owner, threadId: thread, commandId: "send-1", attachments });
        const stranger = yield* Effect.flip(claim("user_2", threadId, [shot]));
        expect(stranger.reason).toBe(
          "'shot.png' can't be sent: it is no longer available. Attach it again.",
        );
        const resized = yield* Effect.flip(
          claim(userId, threadId, [{ ...shot, sizeBytes: PNG.length + 1 }]),
        );
        expect(resized.reason).toBe("'shot.png' can't be sent: it doesn't match its upload.");

        const sent = yield* claim(userId, threadId, [shot]);
        const claimed = sent.attachments[0]!;
        expect(claimed.id.startsWith(`${threadSegment(threadId)}-`)).toBe(true);
        // A retried command writes the same copy again, under the same id.
        expect((yield* claim(userId, threadId, [shot])).attachments).toEqual([claimed]);
        // The thread's own attachment passes as stored; a made-up one of the thread doesn't.
        expect((yield* claim(userId, threadId, [claimed])).attachments).toEqual([claimed]);
        const forged = ChatAttachmentId.make(
          `${threadSegment(threadId)}-0b6f6c2e-4d3c-4b8f-9f55-2f4b1d1e9a10`,
        );
        expect(
          (yield* Effect.flip(claim(userId, threadId, [{ ...shot, id: forged }]))).reason,
        ).toBe("'shot.png' can't be sent: it isn't an attachment of this thread.");
        // Another thread's attachment never rides along.
        expect((yield* Effect.flip(claim(userId, "thread:other", [claimed]))).reason).toBe(
          "'shot.png' can't be sent: it isn't an upload of yours.",
        );

        // The transcript links the copy for anyone who sees the thread; the bytes keep the upload's type.
        const resource = { _tag: "attachment", attachmentId: claimed.id } as const;
        const sees = (visible: boolean) => () => Effect.succeed(visible);
        expect((yield* Effect.flip(service.fileUrl("user_2", resource, sees(false))))._tag).toBe(
          "AssetAttachmentNotFoundError",
        );
        const link = yield* service.fileUrl("user_2", resource, sees(true));
        const file = yield* service.openFile(tokenOf(link.relativeUrl));
        expect(file?.headers["content-type"]).toBe("image/png");
        expect(file?.headers["content-disposition"]).toBeUndefined();
        expect(yield* bytesOf(file!.body)).toEqual(PNG);
        // A pending upload links for its uploader only.
        const pending = { _tag: "attachment", attachmentId: shot.id } as const;
        yield* service.fileUrl(userId, pending, sees(false));
        expect((yield* Effect.flip(service.fileUrl("user_2", pending, sees(true))))._tag).toBe(
          "AssetAttachmentNotFoundError",
        );

        // A refused message's copies go again.
        const another = yield* upload(service, userId, PNG);
        const refused = yield* claim(userId, threadId, [another]);
        yield* refused.release;
        expect(objects.keys()).not.toContain(attachmentKey("", refused.attachments[0]!.id));

        // Deleting the pending upload leaves the message's copy alone.
        yield* service.deletePending("user_2", shot.id);
        expect(objects.keys()).toContain(attachmentKey("", shot.id));
        yield* service.deletePending(userId, shot.id);
        yield* service.deletePending(userId, another.id);
        yield* service.deletePending(userId, claimed.id);
        expect(objects.keys()).toEqual([attachmentKey("", claimed.id)]);
      }),
    ),
  );

  it.effect("downloads files that aren't images, sandboxed and with their name", () =>
    withService((service) =>
      Effect.gen(function* () {
        const notes = yield* upload(service, userId, new TextEncoder().encode("<b>hi</b>"), {
          type: "file",
          name: "page.html",
          mimeType: "text/html",
        });
        expect(notes.id).toMatch(/-html$/);
        const sent = yield* service.claim({
          userId,
          threadId: "thread-1",
          commandId: "send-1",
          attachments: [notes],
        });
        const link = yield* service.fileUrl(
          userId,
          {
            _tag: "attachment",
            attachmentId: sent.attachments[0]!.id,
            fileName: "page.html",
            disposition: "inline",
          },
          () => Effect.succeed(true),
        );
        const file = yield* service.openFile(tokenOf(link.relativeUrl));
        expect(file?.headers).toMatchObject({
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="page.html"',
          "content-security-policy": "default-src 'none'; sandbox",
        });
      }),
    ),
  );

  // Live: the memory bucket dates uploads by the wall clock, as R2 does.
  it.live("sweeps pending uploads nobody sent after a day", () =>
    withService((service, objects) =>
      Effect.gen(function* () {
        const stale = yield* upload(service, userId, PNG);
        objects.age(attachmentKey("", stale.id), 25 * 60 * 60_000);
        // The first upload already swept; the next sweep waits its interval.
        const layer = layerAttachments(objects);
        const fresh = yield* CloudAttachments.use((again) => upload(again, userId, PNG)).pipe(
          Effect.provide(layer),
        );
        // The sweep runs beside the upload; let it finish.
        for (let turn = 0; turn < 100 && objects.keys().length > 1; turn++) yield* Effect.yieldNow;
        expect(objects.keys()).toEqual([attachmentKey("", fresh.id)]);
      }),
    ),
  );
});

describe("sending attachments", () => {
  it.effect("keeps a message's attachments in its thread, and none for a refused one", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const layer = cloud.layerPersonal(userId);
      const threads = yield* CloudThreadService.CloudThreadService.pipe(Effect.provide(layer));
      const service = yield* CloudAttachments.pipe(Effect.provide(layer));
      const threadId = ThreadId.make("thread-attachments");
      const shot = yield* upload(service, userId, PNG);
      // A dropped thread arrives as a `.jsonl` file through the same path (`threadContextAttachment.ts`).
      const transcript = yield* upload(
        service,
        userId,
        new TextEncoder().encode('{"type":"x"}\n'),
        {
          type: "file",
          name: "Earlier thread-0123456789abcdef.jsonl",
          mimeType: "application/x-ndjson",
        },
      );

      const launched = yield* threads.launchThread(actor, {
        commandId: CommandId.make("launch-1"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Screenshot",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("message-1"),
          text: "What's broken here?",
          attachments: [shot, transcript],
        },
      });
      const kept = launched.projection.messages[0]?.attachments ?? [];
      expect(kept.map((attachment) => attachment.type)).toEqual(["image", "file"]);
      for (const attachment of kept) {
        expect(attachment.id.startsWith(`${threadSegment(threadId)}-`)).toBe(true);
        expect(cloud.attachmentObjects.keys()).toContain(attachmentKey("", attachment.id));
      }
      expect(kept[1]?.id).toMatch(/-jsonl$/);

      // A message the thread refuses leaves no copy behind.
      const before = cloud.attachmentObjects.keys().length;
      const another = yield* upload(service, userId, PNG);
      const refused = yield* Effect.flip(
        threads.dispatchCommand(actor, {
          type: "message.dispatch",
          commandId: CommandId.make("send-deferred"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("message-2"),
          text: "Later",
          attachments: [another],
          dispatchMode: { type: "defer_start" },
        }),
      );
      expect(refused._tag).toBe("ThreadCommandRejectedError");
      expect(cloud.attachmentObjects.keys()).toHaveLength(before + 1);
    }),
  );
});

describe("the machine's attachments", () => {
  it.effect("serves a thread's attachments to its machine, and nothing else", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const objects = makeMemoryObjects();
        const context = yield* Layer.build(layerThreadObject(":memory:"));
        const engine = Context.get(context, ThreadEngine.ThreadEngine);
        const runner = Context.get(context, ThreadRunner.ThreadRunner);
        const threadId = ThreadId.make("thread-machine");
        const id = ChatAttachmentId.make(
          `${threadSegment(threadId)}-0b6f6c2e-4d3c-4b8f-9f55-2f4b1d1e9a10`,
        );
        yield* Effect.promise(() =>
          objects.put(attachmentKey("", id), PNG, { customMetadata: { mime: "image/png" } }),
        );
        yield* engine.launch(
          actor,
          {
            commandId: CommandId.make("launch-1"),
            threadId,
            projectId: ProjectId.make("scratch"),
            title: "Machine",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5-1",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make("message-1"),
              text: "Look",
              attachments: [
                {
                  type: "image",
                  id,
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: PNG.length,
                },
              ],
            },
          },
          {
            place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
            pools: { top: PERSONAL_POOL_ID, projects: {} },
          },
        );
        const plan = yield* runner.reconcile;
        if (plan.ensure === null) throw new Error("expected a machine request");
        yield* runner.hello({
          type: "hello",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          imageVersion: "test",
          machineId: "machine-1",
          threadId,
          generation: plan.ensure.generation,
          token: plan.ensure.token,
          lastAckedSequence: 0,
        });
        const token = (yield* runner.work).sessions?.token ?? "";
        const call = (path: string, bearer = token) =>
          serveRunnerAttachments(
            new Request(`http://cloud.test${path}`, {
              headers: { authorization: `Bearer ${bearer}` },
            }),
            { objects, prefix: "" },
          ).pipe(Effect.provide(context));

        const listed = yield* call(SESSION_PATHS.attachments);
        expect(yield* Effect.promise(() => listed.json())).toEqual({
          attachments: [
            { type: "image", id, name: "shot.png", mimeType: "image/png", sizeBytes: PNG.length },
          ],
        });
        const file = yield* call(`${SESSION_PATHS.attachments}/${id}`);
        expect(file.status).toBe(200);
        expect(yield* bytesOf(file.body!)).toEqual(PNG);
        expect((yield* call(`${SESSION_PATHS.attachments}/thread-other-x`)).status).toBe(404);
        expect((yield* call(SESSION_PATHS.attachments, "sbs1.x.y")).status).toBe(403);
      }),
    ),
  );
});
