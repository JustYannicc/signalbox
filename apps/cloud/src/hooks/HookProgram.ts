import { ABI_VERSION, KernelProgramRegistry } from "../kernel/KernelAbi.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { WasiStdio } from "../kernel/KernelFileSystem.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import type { HarnessHookJson } from "./HarnessHooks.ts";

export const KERNEL_HOOK_EXECUTABLE = "/usr/bin/signalbox-hook";

const INPUT_CHUNK_BYTES = 16_384;
const USAGE = "Usage: signalbox-hook <id>\n";
const INVALID_INPUT = "signalbox-hook: stdin must contain one UTF-8 JSON value\n";
const HANDLER_FAILED = "signalbox-hook: hook handler failed\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface KernelHookInvocation {
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface KernelHookExecutionResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exit: KernelCommandExit;
}

export type KernelHookInvoker = (
  id: string,
  payload: HarnessHookJson,
  invocation: KernelHookInvocation,
) => Promise<KernelHookExecutionResult>;

export const KERNEL_HOOK_PROGRAM_MANIFEST = Object.freeze({
  name: "signalbox-hook",
  version: "1.0.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze([]),
  entrypoint: "signalbox-hook-v1",
});

/** Reads official hook JSON from this process's stdio and dispatches by opaque ID. */
export function createKernelHookProgram(invoke: KernelHookInvoker) {
  return Object.freeze({
    kind: "async" as const,
    run: async (context: KernelAsyncProgramContext) => {
      const stdin = stdio(context, 0, "read");
      const stdout = stdio(context, 1, "write");
      const stderr = stdio(context, 2, "write");

      if (context.args.length !== 2 || context.args[1] === "") {
        await writeAll(context, stderr, encoder.encode(USAGE));
        return exit(2);
      }

      let payload: HarnessHookJson;
      try {
        payload = parseHookJson(await readInput(context, stdin));
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        if (error instanceof HookInputError) {
          await writeAll(context, stderr, encoder.encode(INVALID_INPUT));
          return exit(2);
        }
        throw error;
      }

      let result: KernelHookExecutionResult;
      try {
        result = await invoke(context.args[1]!, payload, {
          signal: context.signal,
          cwd: context.filesystem.cwd,
          env: context.env,
        });
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        await writeAll(context, stderr, encoder.encode(HANDLER_FAILED));
        return exit(1);
      }

      context.signal.throwIfAborted();
      await writeAll(context, stdout, result.stdout);
      await writeAll(context, stderr, result.stderr);
      return result.exit;
    },
  });
}

/** Register one stable executable binding; hook registrations stay host-owned. */
export function registerKernelHookProgram(
  registry: KernelProgramRegistry,
  invoke: KernelHookInvoker,
): ReadonlyMap<string, KernelProgramBinding> {
  const manifest = KERNEL_HOOK_PROGRAM_MANIFEST;
  const registered = registry.register(manifest);
  if (registered.status === "error") {
    throw Object.assign(
      new Error(`Could not register signalbox-hook: ${registered.error.message}`),
      { code: registered.error.code },
    );
  }
  if (registered.status === "would_block") {
    throw new Error("Kernel hook registry unexpectedly blocked signalbox-hook");
  }
  return new Map([
    [KERNEL_HOOK_EXECUTABLE, { manifest, implementation: createKernelHookProgram(invoke) }],
  ]);
}

async function readInput(
  context: KernelAsyncProgramContext,
  input: StdioEndpoint,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const target = new Uint8Array(INPUT_CHUNK_BYTES);
    const count = await io(context, input, "read", () =>
      input.stream.readInto!(target, input.descriptor.flags),
    );
    if (count === 0) break;
    if (count > target.byteLength) {
      throw Object.assign(new Error("Hook stdin returned an invalid byte count"), { code: "EIO" });
    }
    chunks.push(target.slice(0, count));
    length += count;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseHookJson(bytes: Uint8Array): HarnessHookJson {
  try {
    return JSON.parse(decoder.decode(bytes)) as HarnessHookJson;
  } catch (cause) {
    throw new HookInputError("Hook stdin was not valid UTF-8 JSON", { cause });
  }
}

async function writeAll(
  context: KernelAsyncProgramContext,
  output: StdioEndpoint,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = await io(context, output, "write", () =>
      output.stream.write!(bytes.subarray(offset), output.descriptor.flags),
    );
    if (count > bytes.byteLength - offset) {
      throw Object.assign(new Error("Hook stdio returned an invalid byte count"), { code: "EIO" });
    }
    if (count === 0)
      throw Object.assign(new Error("Hook stdio made no write progress"), { code: "EIO" });
    offset += count;
  }
}

async function io(
  context: KernelAsyncProgramContext,
  endpoint: StdioEndpoint,
  direction: "read" | "write",
  operation: () => number | Promise<number>,
): Promise<number> {
  for (;;) {
    context.signal.throwIfAborted();
    try {
      const count = await operation();
      context.signal.throwIfAborted();
      if (!Number.isSafeInteger(count) || count < 0) {
        throw Object.assign(new Error("Hook stdio returned an invalid byte count"), {
          code: "EIO",
        });
      }
      return count;
    } catch (error) {
      if (!isWouldBlock(error) || endpoint.stream.poll === undefined) throw error;
      await endpoint.stream.poll(direction, context.signal);
    }
  }
}

interface StdioEndpoint {
  readonly descriptor: { readonly flags: number };
  readonly stream: WasiStdio;
}

function stdio(
  context: KernelAsyncProgramContext,
  fd: 0 | 1 | 2,
  direction: "read" | "write",
): StdioEndpoint {
  const descriptor = context.filesystem.descriptors.get(fd);
  const stream = descriptor.stdio;
  if (
    descriptor.kind !== "stdio" ||
    stream === undefined ||
    (direction === "read" ? stream.readInto === undefined : stream.write === undefined)
  ) {
    throw Object.assign(new Error(`Hook fd ${fd} is not connected to ${direction} stdio`), {
      code: "EBADF",
    });
  }
  return { descriptor, stream };
}

function isWouldBlock(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EAGAIN" || error.code === "EWOULDBLOCK";
}

function exit(exitCode: number): KernelCommandExit {
  return { exitCode, signal: 0, coreDumped: false };
}

class HookInputError extends Error {}
