import type { ComputerExecPort } from "../computer/Computer.ts";
import type { ChildWorkerCapacity } from "../computer/ChildWorkerCapacity.ts";
import type {
  NodeGeneratedCode,
  NodeGeneratedCodeInvokeInput,
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
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
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
      return options.capacity.run(invocation.signal, async () => {
        invocation.signal.throwIfAborted();
        const response = await options.generated.invoke({
          ...registration.program,
          input: payload,
        });
        // Consuming the response belongs to the admitted invocation, including error bodies.
        const stdout = new Uint8Array(await response.arrayBuffer());
        invocation.signal.throwIfAborted();
        if (!response.ok) throw new Error(`Hook script failed with HTTP ${response.status}`);
        return { stdout, stderr: new Uint8Array(), exit: successExit };
      });
    },
  };
}
