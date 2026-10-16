import * as NodeServices from "@effect/platform-node/NodeServices";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { type ChatAttachment, ChatAttachmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { makeRunnerAttachments } from "./RunnerAttachments.ts";

const shot: ChatAttachment = {
  type: "image",
  id: ChatAttachmentId.make("thread-1-0b6f6c2e-4d3c-4b8f-9f55-2f4b1d1e9a10"),
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 4,
};
const notes: ChatAttachment = {
  type: "file",
  id: ChatAttachmentId.make("thread-1-7c1e8f0a-3b2d-4e5f-8a9b-0c1d2e3f4a5b-txt"),
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};
/** An earlier attachment whose bytes are gone from the cloud. */
const gone: ChatAttachment = {
  type: "image",
  id: ChatAttachmentId.make("thread-1-1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
  name: "old.png",
  mimeType: "image/png",
  sizeBytes: 3,
};
const BYTES: Record<string, Uint8Array> = {
  [shot.id]: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  [notes.id]: new TextEncoder().encode("hello"),
};

/** The thread's side of `SessionProtocol.ts`'s attachment paths, counting downloads. */
const cloud = (token: string) => {
  const downloads: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const { pathname } = new URL(request.url);
      const authorized = request.headers.authorization === `Bearer ${token}`;
      const id = decodeURIComponent(pathname.slice(SESSION_PATHS.attachments.length + 1));
      const response = !authorized
        ? new Response("denied", { status: 403 })
        : pathname === SESSION_PATHS.attachments
          ? Response.json({ attachments: [shot, notes, gone] })
          : BYTES[id] === undefined
            ? new Response("gone", { status: 404 })
            : (downloads.push(id), new Response(BYTES[id]!.slice()));
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return { client, downloads };
};

describe("RunnerAttachments", () => {
  it.effect("puts the thread's attachments where the adapters read them, once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentsDir = path.join(yield* fs.makeTempDirectoryScoped(), "attachments");
      const { client, downloads } = cloud("session-token");
      const attachments = yield* makeRunnerAttachments({
        cloudUrl: "http://cloud.test/",
        attachmentsDir,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      yield* attachments.bring("session-token", [shot]);
      for (const attachment of [shot, notes]) {
        const file = resolveAttachmentPath({ attachmentsDir, attachment });
        expect(new Uint8Array(yield* fs.readFile(file!))).toEqual(BYTES[attachment.id]);
      }
      // A later turn on the same machine finds them in place.
      yield* attachments.bring("session-token", []);
      expect(downloads).toEqual(expect.arrayContaining([shot.id, notes.id]));
      expect(downloads).toHaveLength(2);

      // An earlier attachment that is gone is skipped; the turn's own must arrive.
      const missing = yield* Effect.flip(attachments.bring("session-token", [gone]));
      expect(missing.status).toBe(404);

      const refused = yield* Effect.flip(attachments.bring("someone-else", []));
      expect(refused.status).toBe(403);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

/** A thread whose `stalls` requests never finish: no answer at all, or bytes that stop coming. */
const stuckCloud = (stalls: "listing" | "answer" | "body") => {
  const requests: Array<string> = [];
  const client = HttpClient.make((request) => {
    const { pathname } = new URL(request.url);
    requests.push(pathname);
    if (pathname === SESSION_PATHS.attachments) {
      return stalls === "listing"
        ? Effect.never
        : Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ attachments: [shot, notes] })),
          );
    }
    const id = decodeURIComponent(pathname.slice(SESSION_PATHS.attachments.length + 1));
    if (id === shot.id) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(BYTES[id]!.slice())));
    }
    if (stalls === "answer") return Effect.never;
    // Two of the five bytes, then nothing, without the stream ever ending.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(BYTES[id]!.slice(0, 2)),
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
  });
  const downloadsOf = (attachment: ChatAttachment) =>
    requests.filter((pathname) => pathname.endsWith(encodeURIComponent(attachment.id))).length;
  return { client, requests, downloadsOf };
};

/** Runs `bring` to its end while the test clock moves, as a stuck request would never let it. */
const bringStuck = (
  stalls: "listing" | "answer" | "body",
  required: ReadonlyArray<ChatAttachment>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentsDir = path.join(yield* fs.makeTempDirectoryScoped(), "attachments");
    const cloud = stuckCloud(stalls);
    const attachments = yield* makeRunnerAttachments({
      cloudUrl: "http://cloud.test",
      attachmentsDir,
    }).pipe(Effect.provideService(HttpClient.HttpClient, cloud.client));
    const fiber = yield* Effect.forkChild(Effect.exit(attachments.bring("token", required)));
    // Real file I/O runs between the timed waits, so a fixed number of clock
    // steps can all land before the download reaches its next timeout and leave
    // it waiting forever. Keep stepping, letting that I/O finish in real time,
    // until the download settles.
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.withLive(Effect.sleep("2 millis"));
    }
    const exit = yield* Fiber.join(fiber);
    return { exit, cloud, attachmentsDir };
  });

describe("RunnerAttachments when the thread stops answering", () => {
  it.effect("gives up on a download that never answers, naming the file, after a retry", () =>
    Effect.gen(function* () {
      const { exit, cloud } = yield* bringStuck("answer", [notes]);
      expect(Option.getOrThrow(Exit.findErrorOption(exit)).message).toContain('"notes.txt"');
      expect(cloud.downloadsOf(notes)).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives up on a download whose bytes stop coming, leaving no partial file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { exit, cloud, attachmentsDir } = yield* bringStuck("body", [notes]);
      expect(Option.getOrThrow(Exit.findErrorOption(exit)).message).toContain('"notes.txt"');
      expect(cloud.downloadsOf(notes)).toBe(3);
      expect(
        (yield* fs.readDirectory(attachmentsDir)).filter((name) => name.endsWith(".download")),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets a turn without files of its own start when the listing hangs", () =>
    Effect.gen(function* () {
      const { exit } = yield* bringStuck("listing", []);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("names the turn's own files when the listing hangs", () =>
    Effect.gen(function* () {
      const { exit } = yield* bringStuck("listing", [notes]);
      expect(Option.getOrThrow(Exit.findErrorOption(exit)).message).toContain('"notes.txt"');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
