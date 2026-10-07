import {
  MODEL_GATEWAY_PATHS,
  type ModelGatewayProvider,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type ThreadObjectNamespace, threadObjectStub } from "../ThreadDirectory.ts";
import { threadOfModelToken } from "./modelToken.ts";
import type { ModelAuthorization } from "./ThreadRunner.ts";

/**
 * The cloud's side of a ModelGateway request: the token names its thread, and
 * that thread's object decides. Reached only through the gateway's service
 * binding (`ModelGrants` in `worker.ts`), never from the internet.
 */

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

export function authorizeModel(
  threads: ThreadObjectNamespace,
  token: string,
  provider: ModelGatewayProvider,
  options: { readonly localWorkerd: boolean },
): Promise<ModelAuthorization> {
  const name = threadOfModelToken(token);
  const threadId = name === null ? null : decodeThreadId(name);
  if (
    threadId === null ||
    threadId._tag === "None" ||
    !Object.hasOwn(MODEL_GATEWAY_PATHS, provider)
  ) {
    return Promise.resolve({ _tag: "denied", reason: "Not a model token." });
  }
  return threadObjectStub(threads, threadId.value, options).authorizeModel(token, provider);
}
