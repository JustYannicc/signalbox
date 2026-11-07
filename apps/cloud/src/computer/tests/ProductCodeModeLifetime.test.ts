import { expect, it, vi } from "vite-plus/test";
import { createProductComputer } from "../ProductComputer.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CODE_MODE_HOST_EXECUTABLE } from "../CodeModeManifest.ts";
import { commandProgramCodes } from "../commandGatewayTesting.ts";
import { childBusyboxFixture } from "../childBusyboxTesting.ts";
import { emptyMachineFilesFixture, machineInventoryFixture } from "../machineInventoryTesting.ts";
import type { CodeModeCellEvents } from "../../codeMode/Types.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it.each(["normal", "local-only"] as const)(
  "cancels and drains a %s product companion without retaining a command slot",
  async (route) => {
    const kernel = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, {
      owner: `test/product-code-mode-${route}`,
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
    });
    const entered = Promise.withResolvers<CodeModeCellEvents>();
    const cancelled = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let stopped = false;
    const order: string[] = [];
    const computer = createProductComputer({
      threadId: `code-mode-${route}`,
      filesystem: kernel.filesystem,
      wakes: kernel.context.wakes,
      signal: new AbortController().signal,
      capacity,
      programs: { ...commandProgramCodes(), codeMode: { mainModule: "unused.js", modules: {} } },
      loader: {
        run: async () => {
          throw new Error("Companion must not launch a command worker");
        },
        cells: {
          async run(_input, events) {
            entered.resolve(events);
            await events.cancelled();
            cancelled.resolve();
            await released.promise;
            await events.closeCallbacks();
            await events.stopped();
            stopped = true;
            order.push("stopped");
            return { terminated: true, error: null, writes: {} };
          },
        },
      },
      machineInventory: machineInventoryFixture(),
      machine: () => ({
        files: emptyMachineFilesFixture(),
        spawn: async () => {
          throw new Error("Companion must remain local");
        },
      }),
    });
    const commands = route === "normal" ? computer : computer.isolate;
    const command = {
      executable: CODE_MODE_HOST_EXECUTABLE,
      argv: [CODE_MODE_HOST_EXECUTABLE],
      cwd: kernel.filesystem.cwd,
      env: {},
    };
    const child = await commands.exec(command, new AbortController().signal, undefined);
    const writer = child.stdin.getWriter();
    const output = Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ]);
    void output.catch(() => {});
    try {
      await writer.write(
        frame({
          type: "connection/hello",
          supportedVersions: [1],
          requiredCapabilities: [],
          optionalCapabilities: [],
        }),
      );
      await writer.write(
        frame({
          type: "operation/request",
          id: 1,
          request: { method: "session/open", sessionId: "lifetime" },
        }),
      );
      await writer.write(
        frame({
          type: "operation/request",
          id: 2,
          request: {
            method: "session/execute",
            sessionId: "lifetime",
            request: {
              tool_call_id: "call",
              source: "await work();",
              enabled_tools: [],
              yield_time_ms: 0,
              max_output_tokens: null,
            },
          },
        }),
      );
      await entered.promise;
      expect(capacity.active).toBe(0);
      const signalling = child.signal(15);
      await cancelled.promise;
      const draining = computer.drain().then(() => {
        order.push("drained");
      });
      expect(stopped).toBe(false);
      await Promise.resolve().then(() => {
        order.push("released");
        released.resolve();
      });
      await signalling;
      await child.exited;
      await draining;
      expect(stopped).toBe(true);
      expect(order).toEqual(["released", "stopped", "drained"]);
      expect(capacity.active).toBe(0);
      await computer.close();
      expect(computer.processes.size).toBe(0);
      await expect(async () =>
        commands.exec(command, new AbortController().signal, undefined),
      ).rejects.toThrow(
        route === "normal" ? "Product Computer closed" : "Computer admission owner changed",
      );
    } finally {
      released.resolve();
      await computer.close();
      await child.dispose();
      writer.releaseLock();
      await output;
      await kernel.close();
    }
  },
);

function frame(message: unknown) {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const bytes = new Uint8Array(payload.length + 4);
  new DataView(bytes.buffer).setUint32(0, payload.length, true);
  bytes.set(payload, 4);
  return bytes;
}

it("preserves an output failure that races with owner cancellation", async () => {
  const { runCodeModeHostConnection } = await import("../../codeMode/Connection.ts");
  const owner = new AbortController();
  const failure = new Error("output transport failed");
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        frame({
          type: "connection/hello",
          supportedVersions: [1],
          requiredCapabilities: [],
          optionalCapabilities: [],
        }),
      );
    },
  });
  const output = new WritableStream<Uint8Array>({
    write() {
      owner.abort(new Error("Owner stopped"));
      throw failure;
    },
  });
  await expect(
    runCodeModeHostConnection({
      input,
      output,
      signal: owner.signal,
      code: { mainModule: "unused.js", modules: {} },
      cellCapacity: {
        acquire: async () => {
          throw new Error("Handshake must not start a cell");
        },
      },
      loader: {
        run: async () => {
          throw new Error("Handshake must not load a cell");
        },
      },
    }),
  ).rejects.toBe(failure);
});
