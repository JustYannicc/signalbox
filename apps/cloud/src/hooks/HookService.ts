import type { ComputerExecPort } from "../computer/Computer.ts";
import type { ChildWorkerCapacity } from "../computer/ChildWorkerCapacity.ts";
import {
  NodeGeneratedCodeCleanupError,
  type NodeGeneratedCode,
  type NodeGeneratedCodeInvokeInput,
} from "../isolate/NodeGeneratedCode.ts";
import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import type {
  HarnessHookCallback,
  HarnessHookInvocationOptions,
  HarnessHookJson,
  HarnessHookRequest,
} from "./HarnessHooks.ts";
import { runHookCommand, type HookExecutionResult } from "./execution/command.ts";

export type { HookExecutionResult } from "./execution/command.ts";

type HookContext = Omit<HarnessHookRequest, "payload">;

export interface HookServiceInvocationOptions extends HarnessHookInvocationOptions {
  readonly cwd: KernelCommand["cwd"];
  readonly env: KernelCommand["env"];
}

export type HookRegistration = HookContext &
  (
    | { readonly kind: "command"; readonly command: Pick<KernelCommand, "executable" | "argv"> }
    | { readonly kind: "signalbox"; readonly callback: HarnessHookCallback }
    | {
        readonly kind: "script";
        readonly program: Omit<NodeGeneratedCodeInvokeInput, "input">;
      }
  );

export interface HookServiceOptions {
  /** Host-owned registrations. Guest arguments select an ID, never an execution policy. */
  readonly registrations: ReadonlyMap<string, HookRegistration>;
  /** The Computer's trusted command binding denies machine escalation. */
  readonly commands: ComputerExecPort;
  readonly generated: Pick<NodeGeneratedCode, "invoke">;
  /** The same admission pool used by every child program in this DO. */
  readonly capacity: Pick<ChildWorkerCapacity, "acquire">;
}

const encoder = new TextEncoder();
const successExit = Object.freeze({ exitCode: 0, signal: 0, coreDumped: false });

/** Dispatches configured hooks; the official harness owns matching and decision semantics. */
export function createHookService(options: HookServiceOptions) {
  // Snapshot registration membership so guest mutation cannot install another handler.
  const registrations = new Map(options.registrations);

  return {
    async invoke(
      id: string,
      payload: HarnessHookJson,
      invocation: HookServiceInvocationOptions,
    ): Promise<HookExecutionResult> {
      invocation.signal.throwIfAborted();
      const registration = registrations.get(id);
      if (!registration) throw new Error("Unknown hook registration");
      if (registration.kind === "command") {
        return runHookCommand(
          options.commands,
          { ...registration.command, cwd: invocation.cwd, env: invocation.env },
          encoder.encode(`${JSON.stringify(payload)}\n`),
          invocation.signal,
        );
      }
      if (registration.kind === "signalbox") {
        const request: HarnessHookRequest = {
          harness: registration.harness,
          event: registration.event,
          sessionId: registration.sessionId,
          ...(registration.turnId === undefined ? {} : { turnId: registration.turnId }),
          ...(registration.toolCallId === undefined ? {} : { toolCallId: registration.toolCallId }),
          payload,
        };
        const result = await registration.callback(request, invocation);
        invocation.signal.throwIfAborted();
        return {
          stdout: encoder.encode(`${JSON.stringify(result)}\n`),
          stderr: new Uint8Array(),
          exit: successExit,
        };
      }
      const permit = await options.capacity.acquire(invocation.signal);
      let cleanupConfirmed = true;
      try {
        invocation.signal.throwIfAborted();
        const response = await options.generated.invoke(
          {
            ...registration.program,
            input: payload,
          },
          { signal: invocation.signal },
        );
        // Consuming the response belongs to the admitted invocation, including error bodies.
        const stdout = await consumeScriptResponse(response, invocation.signal);
        invocation.signal.throwIfAborted();
        if (!response.ok) throw new Error(`Hook script failed with HTTP ${response.status}`);
        return { stdout, stderr: new Uint8Array(), exit: successExit };
      } catch (error) {
        // A disconnected cancellation RPC does not establish that the child stopped.
        cleanupConfirmed = !(error instanceof NodeGeneratedCodeCleanupError);
        throw error;
      } finally {
        if (cleanupConfirmed) permit.release();
      }
    },
  };
}

async function consumeScriptResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    signal.throwIfAborted();
    return new Uint8Array();
  }
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation ??= reader.cancel(signal.reason);
    void cancellation.catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await cancellation;
    } finally {
      reader.releaseLock();
    }
  }
}
