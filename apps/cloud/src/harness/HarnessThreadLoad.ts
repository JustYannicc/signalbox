import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type { HarnessOpenInput } from "./Harness.ts";

type EnsureThreadInput = Parameters<ProviderAdapterV2SessionRuntime["ensureThread"]>[0];
type ResumeThreadInput = Parameters<ProviderAdapterV2SessionRuntime["resumeThread"]>[0];

export type NativeThreadLoad =
  | {
      readonly method: "ensureThread";
      readonly input: EnsureThreadInput;
    }
  | {
      readonly method: "resumeThread";
      readonly input: ResumeThreadInput;
    };

type CheckpointThreadLoad = Extract<NativeThreadLoad, { readonly method: "resumeThread" }>;
type CheckpointSession = Pick<
  HarnessOpenInput["session"],
  "threadId" | "modelSelection" | "runtimePolicy"
>;
type TurnSession = Pick<HarnessOpenInput["session"], "runtimePolicy">;

export const nativeTurnThreadLoad = (
  turn: RunnerTurn,
  session: TurnSession,
  providerSessionId: HarnessOpenInput["session"]["providerSessionId"],
): NativeThreadLoad => {
  const runtimePolicy = {
    ...session.runtimePolicy,
    runtimeMode: turn.runtimeMode,
    interactionMode: turn.interactionMode,
  };
  return turn.providerThread.nativeThreadRef === null
    ? {
        method: "ensureThread",
        input: {
          threadId: turn.threadId,
          providerSessionId,
          modelSelection: turn.modelSelection,
          runtimePolicy,
          existingProviderThread: turn.providerThread,
        },
      }
    : {
        method: "resumeThread",
        input: {
          providerThread: turn.providerThread,
          threadId: turn.threadId,
          modelSelection: turn.modelSelection,
          runtimePolicy,
        },
      };
};

export const checkpointThreadLoad = (
  checkpoint: {
    readonly snapshot: {
      readonly providerThread: ResumeThreadInput["providerThread"];
    };
  },
  session: CheckpointSession,
): CheckpointThreadLoad => ({
  method: "resumeThread",
  input: {
    providerThread: checkpoint.snapshot.providerThread,
    threadId: session.threadId,
    modelSelection: session.modelSelection,
    runtimePolicy: session.runtimePolicy,
  },
});
