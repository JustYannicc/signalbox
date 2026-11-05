import type {
  KernelFileTransferManifest,
  KernelFileTransferPort,
} from "../kernel/KernelFileTransfer.ts";

export interface ClaudeTranscriptCapture {
  readonly streams: readonly { readonly stream: string; readonly path: string }[];
  readonly manifest: KernelFileTransferManifest;
  readonly source: KernelFileTransferPort;
}
