import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import {
  type ChatAttachment,
  ChatAttachmentId,
  CommandId,
  ComposerContextId,
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
import * as Base64 from "effect/encoding/Base64";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";

import * as Environment from "../environment.ts";
import { layerAttachments, layerConfig, layerThreadObject, makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as ThreadRunner from "../thread/runner/ThreadRunner.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as ThreadEngine from "../thread/ThreadEngine.ts";
import { threadSegment } from "./attachmentIds.ts";
import { makeMemoryObjects } from "./attachmentTesting.ts";
import * as AssetRoutes from "../assets/assetRoutes.ts";
import * as CloudAssets from "../assets/CloudAssets.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as AttachmentRoutes from "./attachmentRoutes.ts";
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
  const retryInput = {
    threadId: ThreadId.make("expired-retry-thread"),
    messageId: MessageId.make("expired-retry-message"),
    attachments: [
      {
        type: "image" as const,
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: PNG.length,
        dataUrl: `data:image/png;base64,${Base64.encode(PNG)}`,
      },
    ],
  };

  it.live("keeps another owner's recreated bytes when a different layer sweeps a stale list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const objects = makeMemoryObjects();
        const seeded = Promise.withResolvers<void>();
        let writes = 0;
        const ownerObjects = {
          ...objects,
          put: (...args: Parameters<typeof objects.put>) => {
            writes++;
            return objects.put(...args);
          },
          list: async (...args: Parameters<typeof objects.list>) => {
            const snapshot = await objects.list(...args);
            seeded.resolve();
            return snapshot;
          },
        };
        const owner = Context.get(
          yield* Layer.build(layerAttachments(ownerObjects)),
          CloudAttachments,
        );
        const saved = yield* owner.persistImages(userId, retryInput);
        yield* Effect.promise(() => seeded.promise);
        const key = attachmentKey("", saved.attachments[0]!.id);
        const otherUser = "user_2";
        const sentinel = attachmentKey("", "pending-00000000-0000-4000-8000-000000000001");
        const orphan = attachmentKey("", "pending-00000000-0000-4000-8000-000000000002");
        yield* Effect.promise(() =>
          objects.put(sentinel, PNG, { customMetadata: { owner: otherUser } }),
        );
        yield* Effect.promise(() => objects.put(orphan, PNG, { customMetadata: {} }));
        for (const expired of [key, sentinel, orphan]) objects.age(expired, 25 * 60 * 60_000);
        const listed = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const swept = Promise.withResolvers<void>();
        const deleted: string[] = [];
        const sweepingObjects = {
          ...objects,
          list: async (...args: Parameters<typeof objects.list>) => {
            const snapshot = await objects.list(...args);
            listed.resolve();
            await release.promise;
            return snapshot;
          },
          delete: async (keys: string | string[]) => {
            deleted.push(...(typeof keys === "string" ? [keys] : keys));
            await objects.delete(keys);
            if (keys.includes(sentinel)) swept.resolve();
          },
        };
        const sweeper = Context.get(
          yield* Layer.build(layerAttachments(sweepingObjects)),
          CloudAttachments,
        );
        yield* Effect.gen(function* () {
          yield* sweeper.issueUpload(otherUser, {
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: PNG.length,
          });
          yield* Effect.promise(() => listed.promise);
          expect(yield* owner.persistImages(userId, retryInput)).toEqual(saved);
          expect(writes).toBe(2);
          const open = () =>
            owner.open({
              userId,
              attachmentId: saved.attachments[0]!.id,
              canSee: () => Effect.succeed(false),
            });
          const before = yield* open();
          expect(before).not.toBeNull();
          expect(yield* bytesOf(before!.body)).toEqual(PNG);
          release.resolve();
          yield* Effect.promise(() => swept.promise);
          const file = yield* open();
          expect(file).not.toBeNull();
          expect(yield* bytesOf(file!.body)).toEqual(PNG);
          expect(deleted).toEqual([sentinel]);
          expect(objects.keys()).toContain(orphan);
          const claimed = yield* owner.claim({
            userId,
            threadId: retryInput.threadId,
            commandId: "send-after-other-owner-sweep",
            attachments: saved.attachments,
          });
          expect(claimed.attachments[0]?.id).toMatch(/^expired-retry-thread-/);
        }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
      }),
    ),
  );

  it.live("throttles sweeps per owner when callers share a layer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const objects = makeMemoryObjects();
        const owners = [userId, "user_2"];
        const keys = owners.map((_, index) =>
          attachmentKey("", `pending-00000000-0000-4000-8000-00000000000${index}`),
        );
        for (const [index, owner] of owners.entries()) {
          const key = keys[index]!;
          yield* Effect.promise(() => objects.put(key, PNG, { customMetadata: { owner } }));
          objects.age(key, 25 * 60 * 60_000);
        }
        const swept = owners.map(() => Promise.withResolvers<void>());
        let lists = 0;
        const tracked = {
          ...objects,
          list: (...args: Parameters<typeof objects.list>) => {
            lists++;
            return objects.list(...args);
          },
          delete: async (deleted: string | string[]) => {
            await objects.delete(deleted);
            for (const [index, key] of keys.entries()) {
              if (deleted.includes(key)) swept[index]!.resolve();
            }
          },
        };
        const service = Context.get(
          yield* Layer.build(layerAttachments(tracked)),
          CloudAttachments,
        );
        const issue = (owner: string) =>
          service.issueUpload(owner, {
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: PNG.length,
          });
        yield* issue(userId);
        yield* Effect.promise(() => swept[0]!.promise);
        expect(objects.keys()).toEqual([keys[1]]);
        yield* issue(userId);
        yield* issue("user_2");
        yield* Effect.promise(() => swept[1]!.promise);
        expect(lists).toBe(2);
        expect(objects.keys()).toEqual([]);
      }),
    ),
  );

  it.live("recreates expired pending bytes without a delayed sweep deleting the retry", () =>
    Effect.gen(function* () {
      const objects = makeMemoryObjects();
      const seeded = Promise.withResolvers<void>();
      const seeding = {
        ...objects,
        list: async (...args: Parameters<typeof objects.list>) => {
          const snapshot = await objects.list(...args);
          seeded.resolve();
          return snapshot;
        },
      };
      const saved = yield* CloudAttachments.use((service) =>
        service.persistImages(userId, retryInput),
      ).pipe(Effect.provide(layerAttachments(seeding)));
      yield* Effect.promise(() => seeded.promise);
      const key = attachmentKey("", saved.attachments[0]!.id);
      // This expired key makes sweep deletion observable even when the retry is fresh.
      const sentinel = attachmentKey("", "pending-00000000-0000-4000-8000-000000000000");
      yield* Effect.promise(() =>
        objects.put(sentinel, PNG, { customMetadata: { owner: userId } }),
      );
      objects.age(key, 25 * 60 * 60_000);
      objects.age(sentinel, 25 * 60 * 60_000);
      const listed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const swept = Promise.withResolvers<void>();
      let writes = 0;
      const gated = {
        ...objects,
        put: (...args: Parameters<typeof objects.put>) => {
          writes++;
          return objects.put(...args);
        },
        list: async (...args: Parameters<typeof objects.list>) => {
          const snapshot = await objects.list(...args);
          listed.resolve();
          await release.promise;
          return snapshot;
        },
        delete: async (keys: string | string[]) => {
          await objects.delete(keys);
          if (keys.includes(sentinel)) {
            swept.resolve();
          }
        },
      };
      yield* CloudAttachments.use((service) =>
        Effect.gen(function* () {
          const retried = yield* service.persistImages(userId, retryInput);
          expect(retried).toEqual(saved);
          yield* Effect.promise(() => listed.promise);
          release.resolve();
          yield* Effect.promise(() => swept.promise);
          const file = yield* service.open({
            userId,
            attachmentId: retried.attachments[0]!.id,
            canSee: () => Effect.succeed(false),
          });
          expect({ writes, readable: file !== null }).toEqual({ writes: 1, readable: true });
          expect(yield* bytesOf(file!.body)).toEqual(PNG);
          const claimed = yield* service.claim({
            userId,
            threadId: retryInput.threadId,
            commandId: "send-after-expired-retry",
            attachments: retried.attachments,
          });
          expect(claimed.attachments[0]?.id).toMatch(/^expired-retry-thread-/);
        }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
      ).pipe(Effect.provide(layerAttachments(gated)));
    }),
  );

  it.live("reuses pending bytes near expiry without risking another write", () =>
    Effect.gen(function* () {
      const objects = makeMemoryObjects();
      const saved = yield* CloudAttachments.use((service) =>
        service.persistImages(userId, retryInput),
      ).pipe(Effect.provide(layerAttachments(objects)));
      objects.age(attachmentKey("", saved.attachments[0]!.id), 23 * 60 * 60_000 + 59 * 60_000);
      let writes = 0;
      const failing = {
        ...objects,
        put: async () => {
          writes++;
          throw new Error("test retry write must not happen");
        },
      };
      yield* CloudAttachments.use((service) =>
        Effect.gen(function* () {
          expect(yield* service.persistImages(userId, retryInput)).toEqual(saved);
          expect(writes).toBe(0);
          const file = yield* service.open({
            userId,
            attachmentId: saved.attachments[0]!.id,
            canSee: () => Effect.succeed(false),
          });
          expect(file).not.toBeNull();
          expect(yield* bytesOf(file!.body)).toEqual(PNG);
        }),
      ).pipe(Effect.provide(layerAttachments(failing)));
    }),
  );

  it.effect("preserves successful pending bytes when a later retry cannot read storage", () => {
    const objects = makeMemoryObjects();
    let reads = 0;
    let writes = 0;
    const failing = {
      ...objects,
      put: (...args: Parameters<typeof objects.put>) => {
        writes++;
        return objects.put(...args);
      },
      head: async (key: string) => {
        if (++reads === 3) throw new Error("test retry lookup failure");
        return objects.head(key);
      },
    };
    return CloudAttachments.use((service) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("successful-retry-thread");
        const input = {
          threadId,
          messageId: MessageId.make("successful-retry-message"),
          attachments: [
            {
              type: "image" as const,
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: PNG.length,
              dataUrl: `data:image/png;base64,${Base64.encode(PNG)}`,
            },
          ],
        };
        const results = yield* Effect.all(
          [
            Effect.result(service.persistImages(userId, input)),
            Effect.result(service.persistImages(userId, input)),
          ],
          { concurrency: 2 },
        );
        const saved = results[0];
        if (saved._tag !== "Success") throw new Error("first request should succeed");
        expect(results[1]._tag).toBe("Failure");
        expect(writes).toBe(1);
        const file = yield* service.open({
          userId,
          attachmentId: saved.success.attachments[0]!.id,
          canSee: () => Effect.succeed(false),
        });
        expect(file).not.toBeNull();
        expect(yield* bytesOf(file!.body)).toEqual(PNG);
        const claimed = yield* service.claim({
          userId,
          threadId,
          commandId: "send-after-retry",
          attachments: saved.success.attachments,
        });
        expect(claimed.attachments[0]?.id).toMatch(/^successful-retry-thread-/);
      }),
    ).pipe(Effect.provide(layerAttachments(failing)));
  });

  it.effect("keeps a successful retry's pending bytes when another write fails", () => {
    const objects = makeMemoryObjects();
    let writes = 0;
    let writing = 0;
    let maximumWriting = 0;
    const failing = {
      ...objects,
      put: async (...args: Parameters<typeof objects.put>) => {
        const attempt = ++writes;
        maximumWriting = Math.max(maximumWriting, ++writing);
        try {
          await objects.put(...args);
          if (attempt === 1) throw new Error("test storage failure");
        } finally {
          writing--;
        }
      },
    };
    return CloudAttachments.use((service) =>
      Effect.gen(function* () {
        const input = {
          threadId: ThreadId.make("retry-thread"),
          messageId: MessageId.make("retry-message"),
          attachments: [
            {
              type: "image" as const,
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: PNG.length,
              dataUrl: `data:image/png;base64,${Base64.encode(PNG)}`,
            },
          ],
        };
        const results = yield* Effect.all(
          [
            Effect.result(service.persistImages(userId, input)),
            Effect.result(service.persistImages(userId, input)),
          ],
          { concurrency: 2 },
        );
        expect(maximumWriting).toBe(1);
        expect(results[0]._tag).toBe("Failure");
        const saved = results[1];
        if (saved._tag !== "Success") throw new Error("retry should succeed");
        const file = yield* service.open({
          userId,
          attachmentId: saved.success.attachments[0]!.id,
          canSee: () => Effect.succeed(false),
        });
        expect(file).not.toBeNull();
        expect(yield* bytesOf(file!.body)).toEqual(PNG);
      }),
    ).pipe(Effect.provide(layerAttachments(failing)));
  });

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
        // A retried command keeps the same copy and id.
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

        // Anyone who sees the thread reads the copy; the bytes keep the upload's type.
        const sees = (visible: boolean) => () => Effect.succeed(visible);
        expect(yield* service.canRead("user_2", claimed.id, sees(false))).toBe(false);
        expect(yield* service.canRead("user_2", claimed.id, sees(true))).toBe(true);
        const read = (reader: string, attachmentId: string, visible: boolean) =>
          service.open({ userId: reader, attachmentId, canSee: sees(visible) });
        expect(yield* read("user_2", claimed.id, false)).toBeNull();
        const file = yield* read("user_2", claimed.id, true);
        expect(file?.headers["content-type"]).toBe("image/png");
        expect(file?.headers["content-disposition"]).toBeUndefined();
        expect(yield* bytesOf(file!.body)).toEqual(PNG);
        // A pending upload is its uploader's only.
        expect(yield* service.canRead(userId, shot.id, sees(false))).toBe(true);
        expect(yield* service.canRead("user_2", shot.id, sees(true))).toBe(false);

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
        const replay = yield* claim(userId, threadId, [shot]);
        expect(replay.attachments).toEqual([claimed]);
        yield* replay.release;
        expect(objects.keys()).toEqual([attachmentKey("", claimed.id)]);
        expect((yield* claim("user_2", threadId, [shot]).pipe(Effect.flip))._tag).toBe(
          "AttachmentRejectedError",
        );
        expect(
          (yield* claim(userId, threadId, [{ ...shot, sizeBytes: PNG.length + 1 }]).pipe(
            Effect.flip,
          ))._tag,
        ).toBe("AttachmentRejectedError");
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
        const file = yield* service.open({
          userId,
          attachmentId: sent.attachments[0]!.id,
          canSee: () => Effect.succeed(false),
          fileName: "page.html",
          disposition: "inline",
        });
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

describe("the upload URL", () => {
  // Live: the web handler checks token expiry against the real clock.
  it.live("takes exactly the promised bytes at the URL the RPC mints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const objects = makeMemoryObjects();
        const context = yield* Layer.build(layerAttachments(objects));
        const service = Context.get(context, CloudAttachments);
        // As the Worker serves them (`app.ts`): services come from the handler's context.
        const httpEffect = yield* HttpRouter.toHttpEffect(AttachmentRoutes.layer);
        const handler = HttpEffect.toWebHandler(httpEffect.pipe(Effect.provide(context)));
        const call = (path: string, init?: RequestInit) =>
          Effect.promise(() => handler(new Request(`https://cloud.test${path}`, init)));

        const minted = yield* service.issueUpload(userId, {
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: PNG.length,
        });
        // Signed tokens run to hundreds of characters, past the router's parameter limit.
        expect(minted.relativeUrl.length).toBeGreaterThan(200);
        const short = yield* call(minted.relativeUrl, { method: "POST", body: PNG.subarray(1) });
        expect(short.status).toBe(400);
        const stored = yield* call(minted.relativeUrl, { method: "POST", body: PNG.slice() });
        expect(stored.status).toBe(204);
        expect(objects.keys()).toEqual([attachmentKey("", minted.attachmentId)]);
        expect((yield* call("/api/attachments/upload/made.up", { method: "POST" })).status).toBe(
          404,
        );
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

describe("links to sent attachments", () => {
  // Live: the asset route checks token expiry against the real clock.
  it.live("serve a sent attachment through the asset route to whoever sees its thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cloud = makeMemoryCloud();
        const context = yield* Layer.build(
          CloudAssets.layer.pipe(
            Layer.provideMerge(cloud.layerPersonal(userId)),
            Layer.provideMerge(CloudTokens.layer),
            Layer.provideMerge(layerConfig()),
          ),
        );
        const threads = Context.get(context, CloudThreadService.CloudThreadService);
        const assets = Context.get(context, CloudAssets.CloudAssets);
        const shot = yield* upload(Context.get(context, CloudAttachments), userId, PNG);
        const launched = yield* threads.launchThread(actor, {
          commandId: CommandId.make("launch-1"),
          threadId: ThreadId.make("thread-links"),
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Screenshot",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make("message-1"),
            text: "Look",
            attachments: [shot],
          },
        });
        const kept = launched.projection.messages[0]!.attachments[0]!;
        const resource = {
          _tag: "attachment" as const,
          attachmentId: kept.id,
          fileName: "shot.png",
        };

        const url = yield* assets.createUrl(actor, resource);
        expect(url.relativeUrl).toMatch(/^\/api\/assets\/[\w-]+\.[\w-]+\/shot\.png$/);
        const httpEffect = yield* HttpRouter.toHttpEffect(AssetRoutes.layer);
        const handler = HttpEffect.toWebHandler(httpEffect.pipe(Effect.provide(context)));
        const file = yield* Effect.promise(() =>
          handler(new Request(`https://cloud.test${url.relativeUrl}`)),
        );
        expect(file.status).toBe(200);
        expect(file.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))).toEqual(PNG);
        // Someone who can't see the thread gets no link.
        const stranger = { userId: "user_2", contextIds: [PERSONAL_CONTEXT_ID] };
        expect((yield* Effect.flip(assets.createUrl(stranger, resource)))._tag).toBe(
          "AssetAttachmentNotFoundError",
        );
      }),
    ),
  );
});

describe("the machine's attachments", () => {
  it.effect("serves legacy persisted images before and after replacing the machine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const objects = makeMemoryObjects();
        const context = yield* Layer.build(layerThreadObject(":memory:"));
        const engine = Context.get(context, ThreadEngine.ThreadEngine);
        const runner = Context.get(context, ThreadRunner.ThreadRunner);
        const threadId = ThreadId.make("thread-machine");
        const persisted = yield* CloudAttachments.use((attachments) =>
          attachments.persistImages(userId, {
            threadId,
            messageId: MessageId.make("message-1"),
            attachments: [
              {
                type: "image",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: PNG.length,
                dataUrl: `data:image/png;base64,${Base64.encode(PNG)}`,
              },
            ],
          }),
        ).pipe(Effect.provide(layerAttachments(objects)));
        const claimed = yield* CloudAttachments.use((attachments) =>
          attachments.claim({
            userId,
            threadId,
            commandId: "launch-1",
            attachments: persisted.attachments,
          }),
        ).pipe(Effect.provide(layerAttachments(objects)));
        const id = claimed.attachments[0]!.id;
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
        yield* runner.ended(plan.ensure.generation, "test machine stopped");
        yield* engine.dispatch(
          actor,
          {
            type: "message.dispatch",
            commandId: CommandId.make("resume-message"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make("message-2"),
            text: "Look again",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          },
          {
            place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
            pools: { top: PERSONAL_POOL_ID, projects: {} },
          },
        );
        const replacement = yield* runner.reconcile;
        if (replacement.ensure === null) throw new Error("expected a replacement machine");
        yield* runner.hello({
          type: "hello",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          imageVersion: "test",
          machineId: "machine-2",
          threadId,
          generation: replacement.ensure.generation,
          token: replacement.ensure.token,
          lastAckedSequence: 0,
        });
        const resumedToken = (yield* runner.work).sessions?.token ?? "";
        const resumed = yield* call(`${SESSION_PATHS.attachments}/${id}`, resumedToken);
        expect(resumed.status).toBe(200);
        expect(yield* bytesOf(resumed.body!)).toEqual(PNG);
      }),
    ),
  );
});

describe("editing queued attachments", () => {
  it.effect(
    "claims replacement uploads, remaps context, preserves omitted fields and clears explicit attachments",
    () =>
      Effect.gen(function* () {
        const cloud = makeMemoryCloud();
        const layer = cloud.layerPersonal(userId);
        const threads = yield* CloudThreadService.CloudThreadService.pipe(Effect.provide(layer));
        const attachments = yield* CloudAttachments.pipe(Effect.provide(layer));
        const threadId = ThreadId.make("queue-attachments");
        yield* threads.launchThread(actor, {
          commandId: CommandId.make("queue-launch"),
          threadId,
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Queued attachments",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Live", attachments: [] },
        });
        yield* threads.dispatchCommand(actor, {
          type: "message.dispatch",
          commandId: CommandId.make("queue-send"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("queued-message"),
          text: "Later",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const queued = (yield* threads.threadSnapshot(actor, threadId)).projection.runs[1]!;
        const shot = yield* upload(attachments, userId, PNG);
        const command = {
          type: "queued-run.edit" as const,
          commandId: CommandId.make("queue-edit-attachments"),
          threadId,
          runId: queued.id,
          text: "Check [context:image:shot]",
          attachments: [shot],
          context: {
            version: 1 as const,
            records: [
              {
                version: 1 as const,
                contextId: ComposerContextId.make("shot"),
                kind: "image" as const,
                label: shot.name,
                attachmentId: shot.id,
                name: shot.name,
                mimeType: shot.mimeType,
                sizeBytes: shot.sizeBytes,
              },
            ],
          },
        };
        const edited = yield* threads.dispatchCommand(actor, command);
        expect(yield* threads.dispatchCommand(actor, command)).toEqual(edited);
        yield* attachments.deletePending(userId, shot.id);
        expect(yield* threads.dispatchCommand(actor, command)).toEqual(edited);
        const saved = (yield* threads.threadSnapshot(actor, threadId)).projection.messages.find(
          (message) => message.id === "queued-message",
        )!;
        const kept = saved.attachments[0]!;
        expect(kept.id).not.toBe(shot.id);
        expect(cloud.attachmentObjects.keys()).toContain(attachmentKey("", kept.id));
        expect(saved.context?.records[0]).toMatchObject({ attachmentId: kept.id });
        yield* threads.dispatchCommand(actor, {
          type: "queued-run.edit",
          commandId: CommandId.make("queue-text-only"),
          threadId,
          runId: queued.id,
          text: "Text only",
        });
        const textOnly = (yield* threads.threadSnapshot(actor, threadId)).projection.messages.find(
          (message) => message.id === saved.id,
        )!;
        expect(textOnly.attachments).toEqual(saved.attachments);
        expect(textOnly.context).toEqual(saved.context);
        // Existing sent attachments pass ownership checks and keep stored metadata.
        yield* threads.dispatchCommand(actor, {
          type: "queued-run.edit",
          commandId: CommandId.make("queue-keep-sent"),
          threadId,
          runId: queued.id,
          text: "Still attached",
          attachments: saved.attachments,
        });
        yield* cloud.settle;
        const delivered = (yield* threads.threadSnapshot(
          actor,
          threadId,
        )).projection.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === saved.id,
        );
        expect(delivered).toMatchObject({
          type: "user_message",
          text: "Still attached",
          attachments: saved.attachments,
          context: saved.context,
        });
      }),
  );

  it.effect(
    "rejects foreign and missing attachments, releases refused copies and keeps old message bytes",
    () =>
      Effect.gen(function* () {
        const cloud = makeMemoryCloud();
        const layer = cloud.layerPersonal(userId);
        const threads = yield* CloudThreadService.CloudThreadService.pipe(Effect.provide(layer));
        const attachments = yield* CloudAttachments.pipe(Effect.provide(layer));
        const threadId = ThreadId.make("queue-attachment-refusals");
        yield* threads.launchThread(actor, {
          commandId: CommandId.make("refusal-launch"),
          threadId,
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Refusals",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Live", attachments: [] },
        });
        const old = yield* upload(attachments, userId, PNG);
        yield* threads.dispatchCommand(actor, {
          type: "message.dispatch",
          commandId: CommandId.make("queue-old"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("old-message"),
          text: "Keep me",
          attachments: [old],
          dispatchMode: { type: "queue_after_active" },
        });
        const before = yield* threads.threadSnapshot(actor, threadId);
        const runId = before.projection.runs[1]!.id;
        const foreign = yield* upload(attachments, "user_2", PNG);
        const crossThread = yield* attachments.claim({
          userId,
          threadId: "other-thread",
          commandId: "other-send",
          attachments: [old],
        });
        const missing = {
          ...old,
          id: ChatAttachmentId.make("pending-00000000-0000-0000-0000-000000000000"),
        };
        for (const [n, replacement] of [foreign, crossThread.attachments[0]!, missing].entries()) {
          expect(
            (yield* threads
              .dispatchCommand(actor, {
                type: "queued-run.edit",
                commandId: CommandId.make(`foreign-${n}`),
                threadId,
                runId,
                text: "Must not land",
                attachments: [replacement],
              })
              .pipe(Effect.flip))._tag,
          ).toBe("ThreadCommandRejectedError");
        }
        expect((yield* threads.threadSnapshot(actor, threadId)).projection).toEqual(
          before.projection,
        );
        const replacement = yield* upload(attachments, userId, PNG);
        const keys = cloud.attachmentObjects.keys().toSorted();
        const empty = yield* threads
          .dispatchCommand(actor, {
            type: "queued-run.edit",
            commandId: CommandId.make("empty-edit"),
            threadId,
            runId,
            text: "  ",
            attachments: [replacement],
          })
          .pipe(Effect.flip);
        expect(empty._tag).toBe("ThreadCommandRejectedError");
        expect(cloud.attachmentObjects.keys().toSorted()).toEqual(keys);
        const cleared = yield* threads.dispatchCommand(actor, {
          type: "queued-run.edit",
          commandId: CommandId.make("clear-attachments"),
          threadId,
          runId,
          text: "Cleared",
          attachments: [],
          context: { version: 1, records: [] },
        });
        expect(cleared.sequence).toBeGreaterThan(before.snapshotSequence);
        const afterClear = yield* threads.threadSnapshot(actor, threadId);
        expect(
          afterClear.projection.messages.find((message) => message.id === "old-message"),
        ).toMatchObject({ attachments: [], context: { version: 1, records: [] } });
        // Historical message events still refer to these bytes, so edits never delete them.
        expect(cloud.attachmentObjects.keys()).toContain(
          attachmentKey(
            "",
            before.projection.messages.find((message) => message.id === "old-message")!
              .attachments[0]!.id,
          ),
        );
        yield* threads.dispatchCommand(actor, {
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel-before-edit"),
          threadId,
          runId,
        });
        const staleKeys = cloud.attachmentObjects.keys().toSorted();
        const stale = {
          type: "queued-run.edit" as const,
          commandId: CommandId.make("stale-with-upload"),
          threadId,
          runId,
          text: "Too late",
          attachments: [replacement],
        };
        expect((yield* threads.dispatchCommand(actor, stale).pipe(Effect.flip))._tag).toBe(
          "ThreadCommandRejectedError",
        );
        expect((yield* threads.dispatchCommand(actor, stale).pipe(Effect.flip))._tag).toBe(
          "ThreadCommandRejectedError",
        );
        expect(cloud.attachmentObjects.keys().toSorted()).toEqual(staleKeys);
        expect((yield* threads.threadSnapshot(actor, threadId)).projection.messages).toEqual(
          afterClear.projection.messages,
        );
      }),
  );
});
