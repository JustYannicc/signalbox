import { describe, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../../infra/harnessProof/codeMode/prepare.ts";
import {
  CODE_MODE_HOST_EXECUTABLE,
  createCodeModeHostProgram,
  createCodeModeWorkerLoader,
} from "../../CodeModeHost.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { callKernel, KernelProgramRegistry } from "../../../kernel/KernelAbi.ts";
import { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../../kernel/KernelWakeRegistry.ts";
import { vmWorkerLoader } from "./vmLoader.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("CodeMode registered process", () => {
  it("uses canonical process identity and binary descriptors through fragmented, backpressured frames", async () => {
    const preparedCode = await prepareCodeModeHost();
    const workers = vmWorkerLoader();
    const capacity = new ChildWorkerCapacity(2);
    const program = createCodeModeHostProgram({
      loader: createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } }),
      capacity,
      code: preparedCode.code,
    });
    const registry = new KernelProgramRegistry();
    expect(registry.register(program.binding.manifest).status).toBe("ok");
    const wakes = new KernelWakeRegistry();
    const host = new KernelProgramHost({
      registry,
      wakes,
      programs: new Map([[CODE_MODE_HOST_EXECUTABLE, program.binding]]),
    });
    const filesystem = new KernelFileSystem({ mounts: [] });
    const piped = host.preparePiped({ filesystem });
    const writer = piped.stdin.getWriter();
    const reader = piped.stdout.getReader();
    const frames = binaryFrames(reader);
    try {
      expect(host.resolve("codex-code-mode-host")).toMatchObject({
        status: "error",
        error: { code: "NOT_FOUND" },
      });
      const resolved = host.resolve(CODE_MODE_HOST_EXECUTABLE);
      if (resolved.status !== "ok") throw new Error("Companion resolution failed");
      const spawned = callKernel(host.backend(piped.prepared), "process.spawn", {
        program: resolved.value,
        args: [CODE_MODE_HOST_EXECUTABLE],
        env: {},
      });
      if (spawned.status !== "ok") throw new Error("Companion process admission failed");
      expect(host.processes.size).toBe(1);
      const hello = frame({
        type: "connection/hello",
        supportedVersions: [1],
        requiredCapabilities: [],
        optionalCapabilities: [],
      });
      await writer.write(hello.subarray(0, 1));
      await writer.write(hello.subarray(1, 3));
      await writer.write(hello.subarray(3));
      expect((await frames.next()).value).toMatchObject({
        type: "connection/ready",
        selectedVersion: 1,
      });
      await writer.write(
        frame({
          type: "operation/request",
          id: 1,
          request: { method: "session/open", sessionId: "binary" },
        }),
      );
      expect((await frames.next()).value).toMatchObject({
        type: "operation/response",
        id: 1,
        result: { status: "ok" },
      });
      await writer.write(
        frame({
          type: "operation/request",
          id: 2,
          request: {
            method: "session/execute",
            sessionId: "binary",
            request: {
              source: 'text("hello\\u0000世界" + "x".repeat(70000));',
              tool_call_id: "binary",
              enabled_tools: [],
              yield_time_ms: 1000,
              max_output_tokens: null,
            },
          },
        }),
      );
      let initial: Record<string, unknown> | undefined;
      while (initial === undefined) {
        const next = await frames.next();
        if (next.value?.type === "execute/initialResponse") initial = next.value;
      }
      expect(initial).toMatchObject({
        result: {
          value: {
            Result: {
              content_items: [{ type: "input_text", text: `hello\u0000世界${"x".repeat(70000)}` }],
            },
          },
        },
      });
      const drainingOutput = (async () => {
        for await (const _message of frames) {
        }
      })();
      await writer.close();
      expect(await host.exitStatus(spawned.value)).toMatchObject({
        status: "ok",
        value: { exitCode: 0, signal: 0 },
      });
      await drainingOutput;
      expect(host.reap(spawned.value).status).toBe("ok");
      await program.drain();
      expect(capacity.active).toBe(0);
      expect(host.processes.size).toBe(0);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      writer.releaseLock();
      await host.processes.dispose();
      await program.drain();
      await piped.prepared.release();
      filesystem.dispose();
      wakes.dispose();
    }
  });
});

function frame(message: unknown) {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const bytes = new Uint8Array(payload.length + 4);
  new DataView(bytes.buffer).setUint32(0, payload.length, true);
  bytes.set(payload, 4);
  return bytes;
}

async function* binaryFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  let buffer: Uint8Array = new Uint8Array(0);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      expect(buffer.length).toBe(0);
      return;
    }
    const next = new Uint8Array(buffer.length + chunk.value.length);
    next.set(buffer);
    next.set(chunk.value, buffer.length);
    buffer = next;
    while (buffer.length >= 4) {
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true);
      if (buffer.length < length + 4) break;
      yield JSON.parse(new TextDecoder().decode(buffer.subarray(4, length + 4)));
      buffer = buffer.slice(length + 4);
    }
  }
}
