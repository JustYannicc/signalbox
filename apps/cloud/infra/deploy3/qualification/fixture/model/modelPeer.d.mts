import type { ModelRecoveryEvidence } from "../../../../../src/harness/processResume/tests/modelPhysicalRecovery.fixture.ts";

export interface ModelTurnExpectation {
  readonly turn: number;
  readonly prompt: string;
  readonly finalText: string;
  readonly actions: readonly unknown[];
}

export interface ModelExpectations {
  readonly turns: readonly ModelTurnExpectation[];
}

export interface ModelSocketDrain {
  readonly incarnation: string;
  readonly socketCount: number;
  readonly alreadyClosed: number;
  readonly closedAndJoined: boolean;
}

export interface ModelPhysicalRecoveryInput {
  readonly fromIncarnation: string;
  readonly toIncarnation: string;
  readonly nativeSessionId: string;
  readonly checkpoint: unknown;
  readonly receipt: ModelRecoveryEvidence;
}

export interface ModelCombinedCodexPeerOptions {
  readonly WebSocketPair: new () => { readonly 0: unknown; readonly 1: unknown };
  readonly persistModelRecord: (record: Record<string, unknown>) => Promise<void>;
  readonly verifyNativeTerminal: (input: {
    readonly turn: number;
    readonly nativeSessionId: string;
    readonly incarnation: string;
    readonly expectedFinalText: string;
    readonly receipt: unknown;
  }) => Promise<{ readonly durable: boolean; readonly terminalCount: number }>;
  readonly verifyReplacement: (input: {
    readonly afterCompletedTurn: number;
    readonly fromIncarnation: string;
    readonly toIncarnation: string;
    readonly nativeSessionId: string;
    readonly receipt: { readonly sequence: number };
    readonly modelSocketDrain: unknown;
  }) => Promise<{
    readonly durable: boolean;
    readonly stopConfirmed: boolean;
    readonly joinConfirmed: boolean;
    readonly oldWriterFenced: boolean;
  }>;
  readonly verifyPhysicalRecovery: (input: ModelPhysicalRecoveryInput) => Promise<{
    readonly durable: boolean;
    readonly retirementCompleted: boolean;
    readonly nativeSessionId: string;
    readonly checkpoint: unknown;
  }>;
}

export interface CombinedCodexModelPeer {
  readonly expectations: ModelExpectations;
  readonly failure: Promise<Error>;
  readonly failureError: Error | undefined;
  readonly activeSockets: number;
  prepareIncarnation(incarnation: string): {
    readonly incarnation: string;
    readonly ordinal: number;
  };
  recoverIncarnation(input: ModelPhysicalRecoveryInput): Promise<{
    readonly fromIncarnation: string;
    readonly toIncarnation: string;
    readonly nativeSessionId: string;
    readonly checkpoint: unknown;
    readonly receipt: ModelRecoveryEvidence;
    readonly logicalIncarnation: number;
    readonly ordinal: number;
    readonly modelSocketDrain: ModelSocketDrain;
    readonly verification: {
      readonly durable: boolean;
      readonly retirementCompleted: boolean;
      readonly nativeSessionId: string;
      readonly checkpoint: unknown;
    };
  }>;
  bindNativeSession(nativeSessionId: string): { readonly nativeSessionId: string };
  beginTurn(input: {
    readonly turn: number;
    readonly incarnation: string;
    readonly prompt: string;
  }): {
    readonly turn: number;
    readonly incarnation: string;
    readonly prompt: string;
  };
  completeNativeTurn(input: { readonly turn: number; readonly receipt: unknown }): Promise<{
    readonly turn: number;
    readonly nativeSessionId: string;
    readonly terminalCount: number;
  }>;
  recordReplacement(input: {
    readonly afterCompletedTurn: number;
    readonly fromIncarnation: string;
    readonly toIncarnation: string;
    readonly nativeSessionId: string;
    readonly receipt: { readonly sequence: number };
  }): Promise<{
    readonly afterCompletedTurn: number;
    readonly fromIncarnation: string;
    readonly toIncarnation: string;
    readonly nativeSessionId: string;
    readonly modelSocketDrain: ModelSocketDrain;
    readonly verification: {
      readonly durable: boolean;
      readonly stopConfirmed: boolean;
      readonly joinConfirmed: boolean;
      readonly oldWriterFenced: boolean;
    };
  }>;
  assertComplete(): {
    readonly nativeSessionId: string;
    readonly completedTurns: number;
    readonly replacements: number;
    readonly startupRequests: number;
    readonly modelRequests: number;
    readonly modelResponseTerminals: number;
    readonly toolCalls: number;
    readonly toolResults: number;
    readonly modelRecordCount: number;
  };
  fetch(request: Request): Response;
  joinClosed(): Promise<{ readonly activeSockets: number; readonly closedSockets: number }>;
  closeIncarnationAndJoin(incarnation: string): Promise<ModelSocketDrain>;
  closeAndJoin(): Promise<{ readonly closedSockets: number }>;
  snapshot(): Readonly<Record<string, unknown>>;
}

export const EXPECTATIONS: ModelExpectations;
export function createCombinedCodexModelPeer(
  options: ModelCombinedCodexPeerOptions,
): CombinedCodexModelPeer;
export function expectedResponseIds(physicalIncarnations?: number): string[];
export function expectedToolCallIds(): string[];
export function expectedAssistantMessageIds(): string[];
