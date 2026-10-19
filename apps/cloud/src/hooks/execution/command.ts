import type { ComputerExecPort } from "../../computer/Computer.ts";
import type { KernelCommand, KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";

export interface HookExecutionResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exit: KernelCommandExit;
}

export async function runHookCommand(
  computer: ComputerExecPort,
  command: KernelCommand,
  input: Uint8Array,
  signal: AbortSignal,
): Promise<HookExecutionResult> {
  signal.throwIfAborted();
  const child = await computer.exec(command, signal);
  const writer = child.stdin.getWriter();
  const stdout = child.stdout.getReader();
  const stderr = child.stderr.getReader();
  let cleanup: Promise<void> | undefined;
  const dispose = () => (cleanup ??= child.dispose());
  const aborted = () => {
    // Disposal terminates and drains the owned child; admission stays held until it finishes.
    void dispose().catch(() => undefined);
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  let pending: readonly Promise<unknown>[] = [];
  try {
    signal.throwIfAborted();
    const outputTask = readOutput(stdout);
    const errorTask = readOutput(stderr);
    const inputTask = (async () => {
      try {
        await writer.write(input);
        await writer.close();
      } catch (error) {
        // Native hooks may refuse a tool and exit before consuming the whole event.
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EPIPE"
        ) {
          throw error;
        }
      }
    })();
    pending = [outputTask, errorTask, child.exited, inputTask];
    const [output, error, exit] = await Promise.all([
      outputTask,
      errorTask,
      child.exited,
      inputTask,
    ]);
    signal.throwIfAborted();
    return { stdout: output, stderr: error, exit };
  } finally {
    signal.removeEventListener("abort", aborted);
    try {
      await dispose();
    } finally {
      await Promise.allSettled(pending);
      writer.releaseLock();
      stdout.releaseLock();
      stderr.releaseLock();
    }
  }
}

async function readOutput(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    size += next.value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
