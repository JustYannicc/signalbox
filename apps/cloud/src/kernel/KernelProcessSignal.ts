/** Kept on AbortSignal.reason so a replacement image receives the delivered signal. */
export class KernelProcessSignal extends Error {
  readonly signal: 9 | 15;

  constructor(signal: 9 | 15) {
    super(`Process received signal ${signal}`);
    this.name = "KernelProcessSignal";
    this.signal = signal;
  }
}
