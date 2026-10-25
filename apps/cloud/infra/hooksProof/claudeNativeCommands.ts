import {
  createNodeChildProcess,
  type NodeChildProcess,
  type NodeChildProcessContext,
  type NodeChildProcessOptions,
  type NodeChildProcessWithPipes,
} from "../../src/isolate/NodeChildProcess.ts";
import type { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import type { StandardProofAdapter } from "./standardProofAdapter.ts";

type PipedOptions = NodeChildProcessOptions & { readonly stdio?: "pipe" | null | undefined };

/** Native Claude redirects Bash output into files owned by its canonical Node runtime. */
export function createClaudeNativeCommands(
  host: KernelProgramHost,
  context: NodeChildProcessContext,
  standard: StandardProofAdapter,
) {
  const base = createNodeChildProcess(host, context);
  function spawn(file: string, options?: PipedOptions): NodeChildProcessWithPipes;
  function spawn(file: string, options: NodeChildProcessOptions): NodeChildProcess;
  function spawn(file: string, args: readonly string[]): NodeChildProcessWithPipes;
  function spawn(
    file: string,
    args: readonly string[],
    options?: PipedOptions,
  ): NodeChildProcessWithPipes;
  function spawn(
    file: string,
    args: readonly string[],
    options: NodeChildProcessOptions,
  ): NodeChildProcess;
  function spawn(
    file: string,
    argsOrOptions?: readonly string[] | NodeChildProcessOptions,
    options?: NodeChildProcessOptions,
  ): NodeChildProcess {
    const args = isArguments(argsOrOptions) ? argsOrOptions : [];
    const input = isOptions(argsOrOptions) ? argsOrOptions : (options ?? {});
    if (file !== "/bin/bash") return base.spawn(file, args, input);
    const root = context.filesystem;
    const descriptors = root.descriptors.fork(
      [...root.descriptors.entries()]
        .filter(([, descriptor]) => descriptor.kind !== "file")
        .map(([fd]) => ({ parentFd: fd, childFd: fd })),
    );
    const filesystem = root.fork(descriptors);
    const identity = { executable: file, argv: [input.argv0 ?? file, ...args] };
    const pending: Array<ReturnType<typeof outputFileSink>> = [];
    let child: NodeChildProcess | undefined;
    const release = () => {
      try {
        for (const [fd] of descriptors.entries()) filesystem.close(fd);
      } finally {
        filesystem.dispose();
      }
    };
    try {
      const stdio = Array.isArray(input.stdio) ? [...input.stdio] : input.stdio;
      if (Array.isArray(stdio)) {
        const sinks = new Map<number, number>();
        for (const index of [1, 2]) {
          const target = stdio[index];
          if (typeof target !== "number" || root.descriptors.get(target).kind !== "file") continue;
          let sink = sinks.get(target);
          if (sink === undefined) {
            const output = outputFileSink(filesystem, root, target, standard, (bytes) => {
              if (index === 1) standard.output.record(identity, bytes);
            });
            pending.push(output);
            sink = output.fd;
            sinks.set(target, sink);
          }
          stdio[index] = sink;
        }
      }
      child = createNodeChildProcess(host, { ...context, filesystem }).spawn(file, args, {
        ...input,
        stdio,
      });
      const started = child;
      const finish = (success: boolean) => {
        for (const output of pending) output.finish(success);
      };
      started.prependOnceListener("exit", (code: number | null, signal: string | null) => {
        try {
          finish(code === 0 && signal === null);
        } catch (error) {
          started.emit("error", error);
        }
      });
      started.prependOnceListener("close", () => {
        try {
          finish(false);
        } finally {
          release();
        }
      });
      return started;
    } finally {
      if (child === undefined) {
        try {
          for (const output of pending) output.finish(false);
        } finally {
          release();
        }
      }
    }
  }
  return { ...base, spawn };
}

function isArguments(
  input: readonly string[] | NodeChildProcessOptions | undefined,
): input is readonly string[] {
  return Array.isArray(input);
}

function isOptions(
  input: readonly string[] | NodeChildProcessOptions | undefined,
): input is NodeChildProcessOptions {
  return input !== undefined && !Array.isArray(input);
}

function outputFileSink(
  filesystem: KernelFileSystem,
  root: KernelFileSystem,
  target: number,
  standard: Pick<StandardProofAdapter, "scrub">,
  capture: (bytes: Uint8Array) => void,
) {
  const original = root.descriptors.get(target);
  const retained = root.descriptors.duplicate(target);
  const parts: Uint8Array[] = [];
  let length = 0;
  let failed = false;
  let finished = false;
  const finish = (success: boolean) => {
    if (finished) return;
    finished = true;
    try {
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      capture(bytes);
      if (!success || failed) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const canonical = new TextEncoder().encode(standard.scrub(text));
      offset = 0;
      while (offset < canonical.byteLength) {
        const written = root.write(retained, canonical.subarray(offset), null);
        if (written <= 0) throw new Error("Proof output file write made no progress");
        offset += written;
      }
    } finally {
      parts.length = 0;
      root.close(retained);
    }
  };
  try {
    const fd = filesystem.descriptors.allocate({
      kind: "stdio",
      offset: 0n,
      rightsBase: original.rightsBase,
      rightsInheriting: 0n,
      flags: original.flags,
      closeOnExec: true,
      stdio: {
        supportsNonblocking: true,
        write(bytes) {
          if (length + bytes.byteLength > 1_048_576) {
            failed = true;
            throw Object.assign(new Error("Proof output exceeded its bound"), { code: "ENOBUFS" });
          }
          parts.push(bytes.slice());
          length += bytes.byteLength;
          return bytes.byteLength;
        },
        poll: () => ({ bytes: 1n }),
      },
    });
    return { fd, finish };
  } catch (error) {
    finish(false);
    throw error;
  }
}
