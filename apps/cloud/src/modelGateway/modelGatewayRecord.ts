import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { NonNegativeInt, RunId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * What the ModelGateway records about each request it serves. It logs the
 * record and reports it to the request's thread over the `ModelGrants` service
 * binding, which decodes it with this schema.
 */

/** Tokens one model request used, as its response reports them. */
export const ModelUsage = Schema.Struct({
  /** Input tokens not read from the cache, for both providers. */
  input: NonNegativeInt,
  output: NonNegativeInt,
  cacheRead: NonNegativeInt,
  /** Input tokens written to the cache. OpenAI does not report any. */
  cacheWrite: NonNegativeInt,
});
export type ModelUsage = typeof ModelUsage.Type;

/** One served request, logged when its response ends. The gateway adds `authMs` before forwarding. */
export const ModelGatewayRecord = Schema.Struct({
  provider: Schema.Literals(["anthropic", "openai"] satisfies ReadonlyArray<ModelGatewayProvider>),
  method: Schema.String,
  path: Schema.String,
  status: Schema.Number,
  /** As the model token names it, unchecked. */
  threadId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(RunId),
  /** The granted turn's trace id. */
  traceId: Schema.NullOr(Schema.String),
  /** Why the thread turned the token down. */
  denied: Schema.optionalKey(Schema.String),
  /** Checking the token with its thread. */
  authMs: Schema.Number,
  /** From forwarding to the upstream's response headers. */
  upstreamHeadersMs: Schema.NullOr(Schema.Number),
  /** From forwarding to the first body chunk: the upstream's time to first token. */
  firstChunkMs: Schema.NullOr(Schema.Number),
  totalMs: Schema.Number,
  /** How a forwarded response's body ended: read to the end, dropped by the caller, or broken. */
  outcome: Schema.optionalKey(Schema.Literals(["complete", "cancelled", "failed"])),
  /** The model the response says served it. */
  model: Schema.NullOr(Schema.String),
  /** Null when the response reports none, or could not be read. */
  usage: Schema.NullOr(ModelUsage),
});
export type ModelGatewayRecord = typeof ModelGatewayRecord.Type;
