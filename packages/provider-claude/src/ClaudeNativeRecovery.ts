import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

export interface ClaudeNativeFileLocator {
  readonly filesystemId: string;
  readonly home: string;
}

export interface ClaudeNativeReference {
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ClaudeNativeAdmission {
  readonly logicalRunId: string;
  readonly nativeIncarnationId: string;
  readonly nativeSessionId: string;
  readonly nativeFiles: ClaudeNativeFileLocator;
  readonly providerRelease: string;
  readonly inputId: string;
  readonly nativeInputId: string;
  readonly nativeTurnId: null;
  readonly inputDurability: "reserved" | "native-file";
}

export interface ClaudeNativePendingAction {
  readonly id: string;
  readonly kind: "command" | "result" | "approval";
  readonly state: "unknown" | "running" | "completed" | "answered" | "attached" | "not-accepted";
  readonly reference: ClaudeNativeReference;
}

export interface ClaudeNativeInspection {
  readonly file: { readonly path: string; readonly reference: ClaudeNativeReference };
  readonly stopped: {
    readonly nativeIncarnationId: string;
    readonly reference: ClaudeNativeReference;
  };
  readonly nativeSessionId: string;
  readonly nativeInputId: string;
  readonly headLine: number;
  readonly inputLine: number;
  readonly pendingNativeCallIds: ReadonlyArray<string>;
  readonly state: "unfinished" | "completed" | "interrupted";
}

export interface ClaudeNativeRecoveryPlan {
  readonly status: "ready";
  readonly admission: ClaudeNativeAdmission;
  readonly evidence: ClaudeNativeInspection;
}

export type ClaudeNativeRecoveryOutcome =
  | ClaudeNativeRecoveryPlan
  | {
      readonly status: "completed";
      readonly admission: ClaudeNativeAdmission;
      readonly evidence: ClaudeNativeInspection;
      readonly result: ClaudeNativeReference;
    }
  | {
      readonly status: "waiting" | "indeterminate" | "unsupported";
      readonly admission: ClaudeNativeAdmission;
      readonly reason: string;
      readonly pendingAction?: ClaudeNativePendingAction;
      readonly canDeliverStoredAnswer?: false;
      readonly evidence?: ClaudeNativeInspection;
    };

export interface ClaudeNativeReceipt {
  readonly status:
    | "reserved"
    | "native-accepted"
    | "native-admitted"
    | "continued"
    | "completed"
    | "indeterminate";
  readonly admission: ClaudeNativeAdmission;
  readonly operation:
    | "prompt/offer"
    | "query/resume-interrupted"
    | "command_lifecycle"
    | "stream_event/message_start"
    | "native-file"
    | "result"
    | "query/exit";
  readonly nativePromptId: string | null;
  readonly nativeMessageId: string | null;
  readonly nativeFile?: ClaudeNativeInspection["file"];
  readonly nativeModelRequest?: ClaudeNativeReference;
  readonly terminalStatus?: "completed" | "failed" | "interrupted";
  readonly reason?: string;
}

export interface ClaudeNativeModelRequest {
  readonly logicalRunId: string;
  readonly nativeIncarnationId: string;
  readonly nativeSessionId: string;
  readonly reference: ClaudeNativeReference;
}

export interface ClaudeNativeRecoveryBinding {
  readonly mode:
    | { readonly type: "new-turn"; readonly admission: ClaudeNativeAdmission }
    | { readonly type: "resume-unfinished"; readonly plan: ClaudeNativeRecoveryPlan };
  readonly beforeNativeStart: (admission: ClaudeNativeAdmission) => Effect.Effect<void, Error>;
  readonly observe: (receipt: ClaudeNativeReceipt) => Effect.Effect<void, Error>;
}

/** Allocates the prompt identity without opening a query or offering any input. */
export const prepareClaudeNativeAdmission = (
  input: Omit<ClaudeNativeAdmission, "nativeInputId" | "nativeTurnId" | "inputDurability">,
  crypto: Pick<Crypto.Crypto, "randomUUIDv4">,
) =>
  crypto.randomUUIDv4().pipe(
    Effect.map((nativeInputId): ClaudeNativeAdmission => ({
      ...input,
      nativeFiles: { ...input.nativeFiles },
      nativeInputId,
      nativeTurnId: null,
      inputDurability: "reserved",
    })),
  );

export function claudeRecoveryAdmission(binding: ClaudeNativeRecoveryBinding) {
  return binding.mode.type === "new-turn" ? binding.mode.admission : binding.mode.plan.admission;
}
