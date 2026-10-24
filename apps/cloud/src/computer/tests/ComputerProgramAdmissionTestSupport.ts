import { vi } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import type { KernelProgramAdmissionRequest } from "../../kernel/KernelProgramAdmission.ts";
import type { KernelProgramImplementation } from "../../kernel/KernelProgramHost.ts";
import { ABI_VERSION, KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { ChildWorkerCapacity, type ChildWorkerSlotRequest } from "../ChildWorkerCapacity.ts";

export function prepared() {
  return Object.freeze({ codeId: "admission-test", residentBytes: 0 });
}

export function requestFor(
  context: KernelAsyncProgramContext,
  implementation: KernelProgramImplementation,
): KernelProgramAdmissionRequest {
  const manifest = {
    name: "tool",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: [],
    entrypoint: "tool",
  };
  const registry = new KernelProgramRegistry();
  registry.register(manifest);
  const resolved = registry.resolve("tool", "1", [ABI_VERSION], {});
  if (resolved.status !== "ok") throw new Error("Could not resolve test program");
  return Object.freeze({
    kind: "exec",
    command: Object.freeze({
      executable: "/bin/tool",
      argv: Object.freeze([...context.args]),
      env: Object.freeze({ ...context.env }),
      cwd: context.filesystem.cwd,
    }),
    baseCwd: context.filesystem.cwd,
    actions: [],
    attributes: undefined,
    filesystem: context.filesystem,
    processes: context.processes,
    signal: context.signal,
    identity: context.identity,
    target: {
      kind: "resolved" as const,
      program: resolved.value,
      binding: {
        manifest,
        implementation,
      },
    },
  });
}

export function machinePort() {
  return {
    spawn: vi.fn(async () => {
      throw new Error("Unexpected machine dispatch");
    }),
  };
}

export function observeTicketReservations(
  capacity: ChildWorkerCapacity,
  onEnqueue?: () => void,
  onReserve?: (request: ChildWorkerSlotRequest) => void,
) {
  const requests: ChildWorkerSlotRequest[] = [];
  const granted: string[] = [];
  const originalEnqueue = capacity.enqueue.bind(capacity);
  const enqueue = vi.spyOn(capacity, "enqueue").mockImplementation((signal, requester) => {
    onEnqueue?.();
    const ticket = originalEnqueue(signal, requester);
    return {
      reserve(code) {
        onReserve?.(code);
        requests.push(code);
        return ticket.reserve(code).then((reservation) => {
          granted.push(code.codeId);
          return reservation;
        });
      },
      cancel: () => ticket.cancel(),
    };
  });
  return { enqueue, requests, granted };
}
