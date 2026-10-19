import type { SecretScrubber } from "@signalbox/runner-protocol/SecretScrubber";
import type { KernelCommand } from "../../src/kernel/KernelCommandForwarder.ts";

type CommandIdentity = Pick<KernelCommand, "executable" | "argv">;
export type ProofNativeFileRead = CommandIdentity & { readonly stdout: Uint8Array };

/** Raw bytes are retained only in this bounded, transient verifier input. */
export function createStandardProofOutput(scrubber: () => SecretScrubber) {
  const reads = new Map<string, ProofNativeFileRead>();
  let closed = false;
  const paths = ["/work/official-write.txt", "/workspace/proof.txt"];
  const record = (command: CommandIdentity, stdout: Uint8Array) => {
    if (closed) return;
    if (stdout.byteLength > 1_048_576) throw new Error("Proof output exceeded its bound");
    const read = { executable: command.executable, argv: [...command.argv], stdout };
    for (const path of paths) {
      if (command.argv.some((arg) => arg.includes(path))) reads.set(path, read);
    }
  };
  return {
    record,
    stdout(command: CommandIdentity, source: ReadableStream<Uint8Array>) {
      const capturedPaths = paths.filter((path) => command.argv.some((arg) => arg.includes(path)));
      if (capturedPaths.length === 0) return source.pipeThrough(scrubber().bytes());
      const parts: Uint8Array[] = [];
      let size = 0;
      const capture = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (size + chunk.byteLength > 1_048_576)
            throw new Error("Proof output exceeded its bound");
          parts.push(chunk.slice());
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          if (closed) return;
          const stdout = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            stdout.set(part, offset);
            offset += part.byteLength;
          }
          record(command, stdout);
        },
      });
      return source.pipeThrough(capture).pipeThrough(scrubber().bytes());
    },
    stderr: (source: ReadableStream<Uint8Array>) => source.pipeThrough(scrubber().bytes()),
    close() {
      closed = true;
      reads.clear();
    },
    takeFileRead(path: string) {
      const read = reads.get(path);
      reads.delete(path);
      return read;
    },
  };
}
