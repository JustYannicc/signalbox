import type { HarnessProcessPlacementWriter } from "../../../../src/harness/HarnessProcessPlacement.ts";
import type { ProcessTerminalEvidence } from "../../../../src/harness/HarnessProcessResume.ts";
import type { PlacementReleaseProof } from "./placementReleaseObserver.fixture.ts";

export type QualifierStep = "turn-1" | "replace" | "turn-2" | "turn-3" | "finish";
export interface ModelIncarnation {
  incarnation: string;
  loaderId: string;
  restored: boolean;
}
export interface WriterRelease {
  sequence: number;
  beforeSequence: number;
  owner: string;
  writer: HarnessProcessPlacementWriter;
  terminals: readonly ProcessTerminalEvidence[];
  releaseProof: PlacementReleaseProof;
}
