import type { BashCaptureState } from "./bash/BashCaptureState.ts";

export const BASH_FORK_CHUNK_BYTES = 64 * 1024;

export interface KernelBashForkState {
  readonly memoryBytes: number;
  readonly stackPointer: number;
  readonly captures: BashCaptureState;
}

/** The parent stays suspended until restored, so reads need no second full memory image. */
export interface KernelBashForkSource {
  state(): Promise<KernelBashForkState>;
  read(offset: number, length: number): Promise<Uint8Array>;
  restored(): Promise<void>;
}
