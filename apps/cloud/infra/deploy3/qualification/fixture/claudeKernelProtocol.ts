import type { ClaudeKernelSessionPort } from "../../../../src/harness/ClaudeKernelSessionPort.ts";
import type {
  KernelFileTransferManifest,
  KernelFileTransferPort,
} from "../../../../src/kernel/KernelFileTransfer.ts";

export interface QualifierClaudeKernelPort extends ClaudeKernelSessionPort {
  checkpointFiles(): Promise<{
    readonly manifest: KernelFileTransferManifest;
    readonly source: KernelFileTransferPort;
    readonly rawCounts: readonly (readonly [string, number])[];
  }>;
  flushDiagnostics(reason: "checkpoint" | "request-settled" | "disposed"): Promise<void>;
  isolateNonceProbe(): Promise<{
    readonly facetNonce: string;
    readonly loaderId: string;
    readonly isolateNonce: string;
  }>;
}
