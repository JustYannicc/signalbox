import type { BoxdProofMachineIdentity, BoxdProofMachineIdentityStatus } from "./Identity.ts";

export const COMPUTER_BOXD_PROOF_STAGE = /^computer-boxd-[a-z0-9]{8,20}$/;
export type ProofMode = "direct" | "nested" | "nested-recovery";
export type StagePhase =
  | "created"
  | "building-runner"
  | "preparing-seed"
  | "deploying"
  | "deployed"
  | "seeding"
  | "running"
  | "recovering"
  | "cleanup-confirmed"
  | "cleanup-unconfirmed"
  | "destroying"
  | "destroyed"
  | "failed-before-deploy"
  | "failed-after-deploy";
export type SafeOutcome = "pending" | "passed" | "failed" | "skipped" | "unknown";
export type CleanupState =
  | "not_started"
  | "pending"
  | "confirmed_absent"
  | "unconfirmed"
  | "worker_retained"
  | "worker_destroyed";

export interface ProofStageFile {
  readonly version: 1;
  readonly stage: string;
  readonly sourceCommit: string;
  readonly phase: StagePhase;
}

export interface ProofReceipt {
  readonly sourceCommit: string;
  readonly stage: string;
  readonly vmNames: readonly string[];
  readonly checks: Readonly<Record<string, SafeOutcome>>;
  readonly cleanup: CleanupState;
  readonly machineIdentityStatus: BoxdProofMachineIdentityStatus;
  readonly machineIdentity?: BoxdProofMachineIdentity;
  readonly inputs?: {
    readonly runnerSha256: string;
    readonly runnerWithoutRegionCommentsSha256?: string;
    readonly runnerBytes: number;
    readonly executableSha256s: readonly string[];
  };
}

export class ProofLauncherFailure extends Error {
  readonly safeMessage: string;
  constructor(safeMessage: string) {
    super(safeMessage);
    this.safeMessage = safeMessage;
    this.name = "ProofLauncherFailure";
  }
}
