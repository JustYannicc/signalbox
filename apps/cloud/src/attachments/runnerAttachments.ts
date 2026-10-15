import { SESSION_PATHS, sessionJson } from "@signalbox/runner-protocol/SessionProtocol";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ThreadRunner } from "../thread/runner/ThreadRunner.ts";
import { bearer } from "../thread/session/sessionRoutes.ts";
import { ThreadEngine } from "../thread/ThreadEngine.ts";
import type { AttachmentStorage } from "./attachmentObjects.ts";
import { attachmentKey } from "./CloudAttachments.ts";

/**
 * The thread's attachments as its machine reads them (`SessionProtocol.ts`),
 * answered in the thread's object with the session token. Only attachments a
 * message of this thread holds are served, so a token never reaches another
 * thread's files.
 */

export const isRunnerAttachmentsPath = (pathname: string) =>
  pathname === SESSION_PATHS.attachments || pathname.startsWith(`${SESSION_PATHS.attachments}/`);

/** Images and files every message of the thread holds; types this build doesn't know stay out. */
const held = (messages: ReadonlyArray<{ readonly attachments: ReadonlyArray<ChatAttachment> }>) =>
  messages.flatMap((message) =>
    message.attachments.filter(
      (attachment) => attachment.type === "image" || attachment.type === "file",
    ),
  );

export const serveRunnerAttachments = (request: Request, storage: AttachmentStorage) =>
  Effect.gen(function* () {
    if (request.method !== "GET") return new Response("Unknown path.", { status: 404 });
    const verdict = yield* ThreadRunner.use((runner) => runner.authorizeSession(bearer(request)));
    if (verdict._tag === "denied") return new Response(verdict.reason, { status: 403 });
    const projection = yield* ThreadEngine.use((engine) => engine.projection);
    const attachments = projection === null ? [] : held(projection.messages);
    const { pathname } = new URL(request.url);
    if (pathname === SESSION_PATHS.attachments) {
      return new Response(sessionJson.attachments.encode({ attachments }), {
        headers: { "content-type": "application/json" },
      });
    }
    // Ids are URL-safe as they are; anything encoded is no attachment of this thread.
    const id = pathname.slice(SESSION_PATHS.attachments.length + 1);
    if (!attachments.some((attachment) => attachment.id === id)) {
      return new Response("Not an attachment of this thread.", { status: 404 });
    }
    const object = yield* Effect.promise(() =>
      storage.objects.get(attachmentKey(storage.prefix, id)),
    );
    return object === null
      ? new Response("The attachment is gone.", { status: 404 })
      : new Response(object.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(object.size),
          },
        });
  }).pipe(
    // Anything unexpected is answered 500, which the Runner retries.
    Effect.catchCause((cause) =>
      Effect.logError("runner attachment request failed", cause).pipe(
        Effect.as(new Response("Attachments are unavailable right now.", { status: 500 })),
      ),
    ),
  );
