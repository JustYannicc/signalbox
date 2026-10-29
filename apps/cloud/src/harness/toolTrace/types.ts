export type HarnessToolHookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

export interface HarnessExpectedToolCall {
  readonly id: string;
  readonly name: string;
  readonly processKey?: string;
  readonly sessionId?: string;
}

export interface HarnessToolTracePathMapping {
  readonly id: string;
  readonly sourceRepositoryPrivate: string;
  readonly cwdPrivate: string;
  readonly cwdMapped: boolean;
}

export interface HarnessToolTraceJoinProvenance {
  readonly templateId: string;
  readonly operandSpan: {
    readonly argvIndex: number;
    readonly start: number;
    readonly end: number;
    readonly unit: "utf16-code-units";
  };
  readonly pathMappingId: string | null;
}

export type HarnessTraceField =
  | { readonly state: "missing" }
  | { readonly state: "present"; readonly value: unknown };

export interface HarnessToolHookReceipt {
  readonly processKey: string;
  readonly event: HarnessToolHookEvent;
  readonly sequence: number;
  readonly callbackToolUseId: string | undefined;
  readonly raw: unknown;
  readonly fields: {
    readonly hook_event_name: HarnessTraceField;
    readonly session_id: HarnessTraceField;
    readonly tool_use_id: HarnessTraceField;
    readonly tool_name: HarnessTraceField;
    readonly tool_input: HarnessTraceField;
    readonly cwd: HarnessTraceField;
  };
}

export interface HarnessChildProcessObservation {
  readonly childId: string;
  readonly processKey: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly raw: unknown;
}

export interface HarnessChildReceipt {
  readonly sequence: number;
  readonly raw: unknown;
}

export interface HarnessChildProcessSpawnRecord extends HarnessChildProcessObservation {
  readonly sequence: number;
}

export interface HarnessChildProcessEvidence extends HarnessChildProcessObservation {
  readonly sequence: number;
  readonly closeReceipts: readonly HarnessChildReceipt[];
  readonly traceReceipts: readonly HarnessChildReceipt[];
}

export type HarnessToolCallVerdict =
  | {
      readonly kind: "joined";
      readonly expected: HarnessExpectedToolCall;
      readonly hooks: {
        readonly pre: HarnessToolHookReceipt;
        readonly terminal: HarnessToolHookReceipt;
      };
      readonly children: readonly [HarnessChildProcessEvidence];
      readonly provenance: HarnessToolTraceJoinProvenance;
    }
  | {
      readonly kind: "no-child";
      readonly expected: HarnessExpectedToolCall;
      readonly hooks: {
        readonly pre: HarnessToolHookReceipt;
        readonly terminal: HarnessToolHookReceipt;
      };
      readonly children: readonly [];
    }
  | {
      readonly kind: "gap";
      readonly expected: HarnessExpectedToolCall;
      readonly reasons: readonly string[];
      readonly preCandidates: readonly HarnessToolHookReceipt[];
      readonly terminalCandidates: readonly HarnessToolHookReceipt[];
      readonly candidateChildIds: readonly string[];
      readonly children: readonly HarnessChildProcessEvidence[];
    };

export interface HarnessToolTraceGap {
  readonly scope: "hook" | "child";
  readonly reason: string;
  readonly processKey?: string;
  readonly hookSequence?: number;
  readonly childId?: string;
  readonly candidateHookSequences?: readonly number[];
}

export interface HarnessProcessCaptureReceipt {
  readonly processKey: string;
  readonly phase: "attached" | "drained";
  readonly complete: boolean;
  readonly sequence: number;
  readonly raw: unknown;
}

export interface HarnessToolTraceResult {
  readonly verdicts: readonly HarnessToolCallVerdict[];
  readonly hooks: readonly HarnessToolHookReceipt[];
  readonly processCaptures: readonly HarnessProcessCaptureReceipt[];
  readonly childProcesses: readonly {
    readonly childId: string;
    readonly evidence: HarnessChildProcessEvidence;
  }[];
  readonly childSpawnObservations: readonly {
    readonly childId: string;
    readonly observations: readonly HarnessChildProcessSpawnRecord[];
  }[];
  readonly unattachedChildReceipts: readonly {
    readonly childId: string;
    readonly kind: "close" | "trace";
    readonly sequence: number;
    readonly raw: unknown;
  }[];
  readonly gaps: readonly HarnessToolTraceGap[];
  readonly coverage: {
    readonly toolCalls: {
      readonly denominator: number;
      readonly joined: number;
      readonly noChild: number;
      readonly gaps: number;
    };
    readonly hookPairs: {
      readonly denominator: number;
      readonly complete: number;
      readonly gaps: number;
      readonly unexpectedEvents: number;
      readonly duplicateEvents: number;
    };
    readonly childProcesses: {
      readonly denominator: number;
      readonly associated: number;
      readonly orphaned: number;
      readonly lifecycleIncomplete: number;
    };
  };
}

export interface HarnessToolTraceOptions {
  readonly pathMapping?: HarnessToolTracePathMapping;
}

export interface MutableChildProcess extends HarnessChildProcessObservation {
  readonly sequence: number;
  readonly closeReceipts: HarnessChildReceipt[];
  readonly traceReceipts: HarnessChildReceipt[];
}

export interface HookPairing {
  readonly terminal?: HarnessToolHookReceipt;
  readonly reasons: string[];
}

export interface ShellCandidate {
  readonly pre: HarnessToolHookReceipt;
  readonly children: readonly MutableChildProcess[];
  readonly provenance: readonly {
    readonly childId: string;
    readonly value: HarnessToolTraceJoinProvenance;
  }[];
  readonly reason?: string;
}

export interface HarnessToolTraceState {
  readonly processCaptures: readonly HarnessProcessCaptureReceipt[];
  readonly hooks: readonly HarnessToolHookReceipt[];
  readonly children: ReadonlyMap<string, MutableChildProcess>;
  readonly spawnObservations: ReadonlyMap<string, readonly HarnessChildProcessSpawnRecord[]>;
  readonly unattachedReceipts: HarnessToolTraceResult["unattachedChildReceipts"];
  readonly pathMapping?: HarnessToolTracePathMapping;
}
