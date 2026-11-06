import type { ClaudeSdkReport } from "./ClaudeSdkHostProtocol.ts";
import type { ClaudeToolHookInput } from "./ClaudeToolObservation.ts";
import type { NodeHarnessBaseInput } from "./node/types.ts";
import type { RpcRequest } from "../rpc/Request.ts";

export interface ClaudeKernelCallbacks {
  model(id: string, request: RpcRequest): Promise<Response>;
  cancel(id: string, reason?: unknown): Promise<void>;
  report(report: ClaudeSdkReport): Promise<void>;
  startup(cause: unknown): Promise<void>;
  observeTool(input: ClaudeToolHookInput, toolUseId: string | undefined): Promise<void>;
  continuation(input: unknown): Promise<void>;
  output(fd: number, bytes: Uint8Array): Promise<void>;
  input(bytes: Uint8Array): Promise<void>;
}

export interface ClaudeKernelSeedSource {
  read(
    stage: "assets" | "programs",
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  releasePayload(path: string, offset: number, length: number): Promise<Uint8Array>;
  release(stage: "assets" | "programs"): Promise<void>;
}

export interface ClaudeKernelProcessConfiguration extends Pick<
  NodeHarnessBaseInput,
  "identity" | "env" | "bun" | "systemIdentity"
> {}
