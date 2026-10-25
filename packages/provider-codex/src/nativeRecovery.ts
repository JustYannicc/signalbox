import type * as Effect from "effect/Effect";

export interface CodexNativeFileLocator {
  readonly filesystemId: string;
  readonly home: string;
}

export interface CodexNativeReference {
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CodexNativeAdmission {
  readonly logicalRunId: string;
  readonly nativeIncarnationId: string;
  readonly nativeSessionId: string;
  readonly nativeFiles: CodexNativeFileLocator;
  readonly providerRelease: string;
  readonly inputId: string;
  readonly nativeInputId: string;
  readonly nativeTurnId: string | null;
  readonly inputDurability: "reserved" | "native-file";
}

export type CodexNativePendingAction = {
  readonly id: string;
  readonly kind: "command" | "result" | "approval";
  readonly state: "unknown" | "running" | "completed" | "answered" | "attached" | "not-accepted";
  readonly reference: CodexNativeReference;
};

export interface CodexNativeInspection {
  readonly file: { readonly path: string; readonly reference: CodexNativeReference };
  readonly stopped: {
    readonly nativeIncarnationId: string;
    readonly reference: CodexNativeReference;
  };
  readonly nativeSessionId: string;
  readonly nativeTurnId: string;
  readonly nativeInputId: string;
  readonly headLine: number;
  readonly inputLine: number;
  readonly pendingNativeCallIds: ReadonlyArray<string>;
  readonly state: "unfinished" | "completed" | "interrupted";
  readonly terminalStatus?: "completed" | "failed";
}

export interface CodexNativeRecoveryPlan {
  readonly status: "ready";
  readonly admission: CodexNativeAdmission;
  readonly evidence: CodexNativeInspection;
}

export type CodexNativeRecoveryOutcome =
  | CodexNativeRecoveryPlan
  | {
      readonly status: "completed";
      readonly admission: CodexNativeAdmission;
      readonly evidence: CodexNativeInspection;
      readonly result: CodexNativeReference;
    }
  | {
      readonly status: "waiting" | "indeterminate" | "unsupported";
      readonly admission: CodexNativeAdmission;
      readonly reason: string;
      readonly pendingAction?: CodexNativePendingAction;
      readonly canDeliverStoredAnswer?: false;
      readonly evidence?: CodexNativeInspection;
    };

export interface CodexNativeReceipt {
  readonly status:
    | "reserved"
    | "native-accepted"
    | "native-admitted"
    | "continued"
    | "completed"
    | "indeterminate";
  readonly admission: CodexNativeAdmission;
  readonly operation: "turn/start" | "turn/started" | "turn/completed" | "native-file";
  readonly nativeTurnId: string | null;
  readonly nativeFile?: CodexNativeInspection["file"];
  readonly terminalStatus?: "completed" | "failed" | "interrupted";
  readonly reason?: string;
}

export interface CodexNativeRecoveryBinding {
  readonly mode:
    | { readonly type: "new-turn"; readonly admission: CodexNativeAdmission }
    | { readonly type: "resume-unfinished"; readonly plan: CodexNativeRecoveryPlan };
  /** The root persists this reservation before the native operation. External work stays gated. */
  readonly beforeNativeStart: (admission: CodexNativeAdmission) => Effect.Effect<void, Error>;
  /** Native acceptance is separate from native-file durability. */
  readonly observe: (receipt: CodexNativeReceipt) => Effect.Effect<void, Error>;
}

export function prepareCodexNativeAdmission(
  input: Omit<CodexNativeAdmission, "nativeInputId" | "nativeTurnId" | "inputDurability">,
): CodexNativeAdmission {
  return {
    ...input,
    nativeFiles: { ...input.nativeFiles },
    nativeInputId: input.inputId,
    nativeTurnId: null,
    inputDurability: "reserved",
  };
}

export function codexRecoveryAdmission(binding: CodexNativeRecoveryBinding) {
  return binding.mode.type === "new-turn" ? binding.mode.admission : binding.mode.plan.admission;
}
