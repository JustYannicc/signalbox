import {
  CONTEXT_API_PREFIX,
  CONTEXT_PATHS,
  contextJson,
} from "@signalbox/runner-protocol/ContextProtocol";
import * as Effect from "effect/Effect";

import type { Bytes } from "../drive/git/gitObjects.ts";
import { type ContextReader, ContextTool } from "./ContextTool.ts";

/**
 * The context API (`ContextProtocol.ts`) under the drive API's prefix. The
 * drive route has already checked the thread's drive token and names the
 * reader; everything here decodes a request, asks `ContextTool`, and encodes
 * its answer, on the drive route's runtime. A failing object answers 503, which the machine retries.
 */

export const isContextApiPath = (pathname: string) => pathname.startsWith(`${CONTEXT_API_PREFIX}/`);

export interface ContextAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string | Bytes;
}

const jsonAnswer = (body: string): ContextAnswer => ({
  status: 200,
  contentType: "application/json",
  body,
});
const textAnswer = (status: number, body: string): ContextAnswer => ({
  status,
  contentType: "text/plain; charset=utf-8",
  body,
});

const decode = <A>(decoder: (text: string) => A, body: string): A | null => {
  try {
    return decoder(body);
  } catch {
    return null;
  }
};

/** One context request, by path, with its JSON body. */
export const serveContextRequest = (reader: ContextReader, path: string, body: string) =>
  Effect.gen(function* () {
    const tool = yield* ContextTool;
    const unreadable = textAnswer(400, "Unreadable request.");
    switch (path) {
      case CONTEXT_PATHS.view:
        return jsonAnswer(contextJson.view.encode(yield* tool.view(reader)));
      case CONTEXT_PATHS.tree: {
        const request = decode(contextJson.treeRequest.decode, body);
        if (request === null) return unreadable;
        return jsonAnswer(contextJson.tree.encode(yield* tool.tree(reader, request)));
      }
      case CONTEXT_PATHS.blob: {
        const request = decode(contextJson.blobRequest.decode, body);
        if (request === null) return unreadable;
        const found = yield* tool.blob(reader, request);
        switch (found._tag) {
          case "blob":
            return { status: 200, contentType: "application/octet-stream", body: found.bytes };
          case "missing":
            return textAnswer(404, "The drive has no such file.");
          case "too_large":
            return textAnswer(413, "The file is too big to read here.");
        }
        return found satisfies never;
      }
      case CONTEXT_PATHS.diff: {
        const request = decode(contextJson.diffRequest.decode, body);
        if (request === null) return unreadable;
        return jsonAnswer(contextJson.diff.encode(yield* tool.diff(reader, request)));
      }
      case CONTEXT_PATHS.search: {
        const request = decode(contextJson.searchRequest.decode, body);
        if (request === null) return unreadable;
        return jsonAnswer(contextJson.search.encode(yield* tool.search(reader, request)));
      }
      case CONTEXT_PATHS.thread: {
        const request = decode(contextJson.threadRequest.decode, body);
        if (request === null) return unreadable;
        return jsonAnswer(contextJson.thread.encode(yield* tool.thread(reader, request)));
      }
      default:
        return textAnswer(404, "Unknown path.");
    }
  }).pipe(
    Effect.catchTags({
      ContextAccessError: (error) => Effect.succeed(textAnswer(403, error.message)),
    }),
    Effect.catch((cause) =>
      Effect.logWarning("context request failed", { path, cause }).pipe(
        Effect.as(textAnswer(503, "The drives are unavailable right now.")),
      ),
    ),
  );

/** A context answer as the HTTP response it is. */
export const contextResponse = (answer: ContextAnswer) =>
  new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": answer.contentType },
  });
