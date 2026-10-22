/** Carries termination through WASM imports and replacement images without becoming an errno. */
export class KernelProcessSignal extends Error {
  readonly signal: 9 | 13 | 15;

  constructor(signal: 9 | 13 | 15) {
    super(`Process received signal ${signal}`);
    this.name = "KernelProcessSignal";
    this.signal = signal;
  }

  get exitStatus() {
    return { exitCode: 0, signal: this.signal, coreDumped: false };
  }
}

export async function kernelProcessExitStatus(run: () => Promise<number>) {
  try {
    return { exitCode: await run(), signal: 0, coreDumped: false };
  } catch (error) {
    if (error instanceof KernelProcessSignal) return error.exitStatus;
    throw error;
  }
}
