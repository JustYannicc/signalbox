import * as NodeAssert from "node:assert/strict";
import {
  emptyMachineFilesFixture,
  machineInventoryFixture,
} from "../../../computer/machineInventoryTesting.ts";
import type { MachineFilesPort } from "../../../computer/MachineFilesPort.ts";
import type {
  KernelCommandForwarder,
  KernelCommandExit,
} from "../../../kernel/KernelCommandForwarder.ts";

export type Scenario = "turn" | "interrupt" | "dispose";

export function machineFixture(scenario: Scenario, assertFilesLive: () => void) {
  const requests: string[] = [];
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let cleanupCount = 0;
  let clean = false;
  const inventory = machineInventoryFixture([
    { path: "/usr/bin/machine-tool", mode: 0o755, uid: 1000, gid: 1000 },
  ]);
  const port: KernelCommandForwarder & { files: MachineFilesPort } = {
    files: emptyMachineFilesFixture(),
    async spawn(command, signal) {
      signal.throwIfAborted();
      requests.push(command.executable);
      NodeAssert.equal(command.executable, "/usr/bin/machine-tool");
      NodeAssert.deepEqual(command.argv, ["/usr/bin/machine-tool", "--recorded"]);
      const exited = Promise.withResolvers<KernelCommandExit>();
      const stop = () => {
        cancelled.resolve();
        exited.resolve({ exitCode: 0, signal: 15, coreDumped: false });
      };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      if (scenario === "turn") exited.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      started.resolve();
      return {
        stdin: new WritableStream(),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("machine output\n"));
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        exited: exited.promise,
        signal: async () => {
          stop();
          return { status: "ok", value: undefined };
        },
        async dispose() {
          cleanupCount++;
          assertFilesLive();
          cleaning.resolve();
          if (scenario !== "turn") await released.promise;
          assertFilesLive();
          signal.removeEventListener("abort", stop);
          clean = true;
        },
      };
    },
  };
  return {
    inventory,
    port,
    requests,
    started: started.promise,
    cancelled: cancelled.promise,
    cleaning: cleaning.promise,
    release: () => released.resolve(),
    get clean() {
      return clean;
    },
    get cleanupCount() {
      return cleanupCount;
    },
  };
}
