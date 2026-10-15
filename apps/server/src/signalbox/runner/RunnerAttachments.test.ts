import * as NodeServices from "@effect/platform-node/NodeServices";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { type ChatAttachment, ChatAttachmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

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
