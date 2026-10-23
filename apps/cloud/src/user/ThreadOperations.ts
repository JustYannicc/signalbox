import {
  OrchestrationV2Command,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadLaunchInput,
  ThreadId,
} from "@t3tools/contracts";

import type { Actor } from "../thread/ThreadAccess.ts";
import * as Threads from "../thread/Threads.ts";
import { jsonCodec } from "../thread/threadWire.ts";

export const userThreadWire = {
  launchInput: jsonCodec(OrchestrationV2ThreadLaunchInput),
  command: jsonCodec(OrchestrationV2Command),
};

/** Binds the normal thread operations to the actor resolved by the user domain. */
export const makeUserThreadOperations = (threads: Threads.Threads["Service"], actor: Actor) => ({
  launch: (input: OrchestrationV2ThreadLaunchInput) => threads.launch(actor, input),
  dispatch: (command: OrchestrationV2Command) => threads.dispatch(actor, command),
  snapshot: (threadId: ThreadId) => threads.snapshot(actor, threadId),
  subscribe: (input: OrchestrationV2SubscribeThreadInput) => threads.subscribe(actor, input),
});
