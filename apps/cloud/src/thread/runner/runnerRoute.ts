import { RUNNER_CONNECT_PATH } from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type ThreadObjectNamespace, threadObjectStub } from "../ThreadDirectory.ts";

/**
 * `RUNNER_CONNECT_PATH?threadId=`: a Runner dialing its thread. The Worker
 * only routes the upgrade to the thread's object; the object checks the
 * Runner's generation and token in `hello`, so nothing here authenticates.
 */

export const isRunnerConnectPath = (pathname: string) => pathname === RUNNER_CONNECT_PATH;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

export function connectRunner(
  threads: ThreadObjectNamespace,
  request: Request,
  options: { readonly localWorkerd: boolean },
): Promise<Response> | Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const threadId = decodeThreadId(new URL(request.url).searchParams.get("threadId"));
  if (threadId._tag === "None") return new Response("Unknown thread", { status: 400 });
  return threadObjectStub(threads, threadId.value, options).fetch(request);
}
