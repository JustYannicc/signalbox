import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  MessageId,
  OrchestrationV2Notification,
  ProviderDriverKind,
  ProviderContinuation,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HarnessError } from "./Harness.ts";

export const HarnessContinuation = Schema.Struct({
  threadId: ThreadId,
  sourceRunId: RunId,
  providerThreadId: ProviderThreadId,
  driver: ProviderDriverKind,
  messageId: MessageId,
  detail: Schema.NullOr(Schema.String),
  notification: Schema.optional(OrchestrationV2Notification),
  delivery: Schema.Literals(["adapter_buffered", "message_text"]),
  completions: ProviderContinuation.fields.completions,
  observations: ProviderContinuation.fields.observations,
});
export type HarnessContinuation = typeof HarnessContinuation.Type;

export interface HarnessContinuationPublisher {
  /** Returns after the normal thread command commits; each call checks current publisher authority. */
  readonly publish: (request: HarnessContinuation) => Effect.Effect<void, HarnessError>;
}

export interface HarnessContinuationRequests {
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
}
