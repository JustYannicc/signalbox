import {
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

const openCodec = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      bootAttemptId: Schema.String,
      session: Schema.Struct({
        threadId: ThreadId,
        providerSessionId: ProviderSessionId,
        modelSelection: ModelSelection,
        runtimePolicy: ProviderAdapterV2RuntimePolicy,
        resumeFromSession: Schema.optionalKey(OrchestrationV2ProviderSession),
        initialNativeThreadId: Schema.optionalKey(Schema.String),
        initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
      }),
      creation: Schema.optionalKey(
        Schema.Struct({ providerThread: OrchestrationV2ProviderThread }),
      ),
      checkpoint: Schema.optionalKey(
        Schema.Struct({
          release: Schema.Struct({
            harness: Schema.Literals(["claude-code", "codex"]),
            version: Schema.String,
            manifestSha256: Schema.String,
            modules: Schema.Record(
              Schema.String,
              Schema.Struct({ bytes: Schema.Number, sha256: Schema.String }),
            ),
          }),
          providerSession: OrchestrationV2ProviderSession,
          snapshot: Schema.Struct({
            providerThread: OrchestrationV2ProviderThread,
            providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
            messages: Schema.Array(OrchestrationV2ConversationMessage),
            runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
            providerPayload: Schema.optional(Schema.Unknown),
          }),
          revision: Schema.Struct({ commit: Schema.String }),
        }),
      ),
    }),
  ),
);
const encodeOpen = Schema.encodeSync(openCodec);
const decodeOpen = Schema.decodeSync(openCodec);
export const snapshotOpen = (input: Parameters<typeof encodeOpen>[0]) =>
  decodeOpen(encodeOpen(input));

export { createBootState } from "../../kernel/KernelHarnessBoot.ts";
