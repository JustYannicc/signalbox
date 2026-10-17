import type { FeedbackOutcome, FeedbackRequest } from "@signalbox/runner-protocol/FeedbackProtocol";
import type {
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

type FeedbackSession = Pick<
  ProviderAdapterV2SessionRuntime,
  "providerSessionId" | "uploadFeedback"
>;

/** Feedback may use only a native thread loaded by this Runner process. Never resume one to upload. */
export const makeRunnerFeedback = (
  threadId: ThreadId,
  currentSession: (instanceId: ProviderInstanceId) => FeedbackSession | undefined,
) => {
  const loaded = new Map<
    string,
    { readonly session: FeedbackSession; readonly thread: OrchestrationV2ProviderThread }
  >();
  const receipts = new Map<string, Effect.Effect<FeedbackOutcome>>();
  return {
    remember: (session: FeedbackSession, thread: OrchestrationV2ProviderThread) => {
      loaded.set(thread.id, { session, thread });
    },
    upload: (request: FeedbackRequest): Effect.Effect<FeedbackOutcome> =>
      Effect.suspend(() => {
        const previous = receipts.get(request.requestId);
        if (previous !== undefined) return previous;
        const upload = Effect.gen(function* () {
          const target = request.providerThread;
          const held = loaded.get(target.id);
          const runtime = currentSession(target.providerInstanceId);
          if (
            target.appThreadId !== threadId ||
            held === undefined ||
            runtime !== held.session ||
            runtime.providerSessionId !== target.providerSessionId ||
            held.thread.nativeThreadRef?.nativeId == null ||
            target.nativeThreadRef?.nativeId == null ||
            target.nativeThreadRef?.nativeId !== held.thread.nativeThreadRef.nativeId ||
            target.driver !== held.thread.driver ||
            target.nativeThreadRef.driver !== held.thread.nativeThreadRef.driver
          ) {
            return { _tag: "failed", failure: "session_unavailable" } as const;
          }
          if (runtime.uploadFeedback === undefined) {
            return { _tag: "failed", failure: "unsupported" } as const;
          }
          return yield* runtime
            .uploadFeedback({
              providerThread: held.thread,
              ...(request.reason === undefined ? {} : { reason: request.reason }),
            })
            .pipe(
              Effect.map(({ feedbackId }): FeedbackOutcome => ({ _tag: "uploaded", feedbackId })),
              // Adapter failures can contain the uploaded content. Only the category leaves here.
              Effect.catchCause(() =>
                Effect.succeed({ _tag: "failed", failure: "upload_failed" } as const),
              ),
            );
        });
        return Effect.gen(function* () {
          const once = yield* Effect.cached(upload);
          receipts.set(request.requestId, once);
          return yield* once;
        });
      }),
  };
};
