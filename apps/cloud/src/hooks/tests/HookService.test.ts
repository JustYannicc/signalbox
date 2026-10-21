import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { describe, expect, it } from "vite-plus/test";
import { createHookService, type HookRegistration } from "../HookService.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";

const requester = {
  processes: new KernelProcessTable({ wakes: new KernelWakeRegistry() }),
  process: undefined,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const context = { harness: "claude-code", event: "pre-tool-use", sessionId: "session" } as const;
const invokeOptions = () => ({
  requester,
  cwd: "/work/a b",
  env: { HOME: "/home/guest", EMPTY: "", PATH: "/bin" },
  signal: new AbortController().signal,
});
const empty = () => new ReadableStream<Uint8Array>({ start: (stream) => stream.close() });
const notUsed = async (): Promise<never> => {
  throw new Error("Wrong hook execution path");
};
const defaults = {
  commands: { exec: notUsed },
  generated: { invoke: notUsed },
  capacity: { acquire: async () => ({ release() {} }) },
};

describe("configured hook execution", () => {
  it("keeps official denial fields and nested input intact through the RPC path", async () => {
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "printf 'Grüezi 😀'", nested: [null, true, 7] },
      future_field: { untouched: true },
    };
    const result = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "A person must approve this command.",
      },
    };
    const service = createHookService({
      ...defaults,
      registrations: new Map([
        [
          "approval",
          {
            ...context,
            kind: "signalbox",
            callback: async (request, options) => {
              expect(request.payload).toEqual(payload);
              options.signal.throwIfAborted();
              return result;
            },
          },
        ],
      ]),
    });
    const output = await service.invoke("approval", payload, invokeOptions());
    expect(JSON.parse(decoder.decode(output.stdout))).toEqual(result);
    expect(output.exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
    expect(output.stderr).toEqual(new Uint8Array());
  });

  it("preserves binary command output, nonzero exit, invocation cwd/env and JSON stdin", async () => {
    let input = "";
    let disposed = 0;
    const exit = { exitCode: 2, signal: 0, coreDumped: false };
    const child: KernelCommandChild = {
      stdin: new WritableStream({
        write: (bytes) => {
          input += decoder.decode(bytes);
        },
      }),
      stdout: new ReadableStream({
        start(stream) {
          stream.enqueue(Uint8Array.of(0, 255));
          stream.enqueue(Uint8Array.of(195, 169, 10));
          stream.close();
        },
      }),
      stderr: new ReadableStream({
        start(stream) {
          stream.enqueue(Uint8Array.of(254, 0, 10));
          stream.close();
        },
      }),
      exited: Promise.resolve(exit),
      signal: notUsed,
      dispose: async () => {
        disposed++;
      },
    };
    const options = invokeOptions();
    const service = createHookService({
      ...defaults,
      commands: {
        exec: async (command, signal) => {
          expect(command).toEqual({
            executable: "/bin/bash",
            argv: ["custom-zero", "-c", "printf hello"],
            cwd: options.cwd,
            env: options.env,
          });
          expect(signal).toBe(options.signal);
          return child;
        },
      },
      registrations: new Map([
        [
          "user-command",
          {
            ...context,
            kind: "command",
            command: {
              executable: "/bin/bash",
              argv: ["custom-zero", "-c", "printf hello"],
            },
          },
        ],
      ]),
    });
    const payload = { hook_event_name: "PreToolUse", text: "Grüezi 😀" };
    const output = await service.invoke("user-command", payload, options);
    expect(input).toBe(`${JSON.stringify(payload)}\n`);
    expect(output.stdout).toEqual(Uint8Array.of(0, 255, 195, 169, 10));
    expect(output.stderr).toEqual(Uint8Array.of(254, 0, 10));
    expect(output.exit).toEqual(exit);
    expect(disposed).toBe(1);
    expect(child.stdin.locked || child.stdout.locked || child.stderr.locked).toBe(false);
  });

  it("holds shared child admission until a generated response body finishes", async () => {
    const bodyStarted = Promise.withResolvers<void>();
    const completeBody = Promise.withResolvers<void>();
    let admitted = false;
    const service = createHookService({
      ...defaults,
      registrations: scriptRegistration(),
      capacity: {
        acquire: async () => {
          admitted = true;
          return {
            release() {
              admitted = false;
            },
          };
        },
      },
      generated: {
        invoke: async () =>
          new Response(
            new ReadableStream({
              async start(stream) {
                bodyStarted.resolve();
                await completeBody.promise;
                expect(admitted).toBe(true);
                stream.enqueue(encoder.encode('{"continue":true}'));
                stream.close();
              },
            }),
          ),
      },
    });
    const pending = service.invoke("script", { official: true }, invokeOptions());
    await bodyStarted.promise;
    expect(admitted).toBe(true);
    completeBody.resolve();
    expect(decoder.decode((await pending).stdout)).toBe('{"continue":true}');
    expect(admitted).toBe(false);
  });

  it("consumes generated failure bodies before releasing admission and rejects the failure", async () => {
    let consumed = false;
    let releasedAfterConsumption = false;
    const service = createHookService({
      ...defaults,
      registrations: scriptRegistration(),
      capacity: {
        acquire: async () => ({
          release() {
            releasedAfterConsumption = consumed;
          },
        }),
      },
      generated: {
        invoke: async () =>
          new Response(
            new ReadableStream({
              pull(stream) {
                consumed = true;
                stream.close();
              },
            }),
            { status: 500 },
          ),
      },
    });
    await expect(service.invoke("script", null, invokeOptions())).rejects.toThrow("HTTP 500");
    expect(releasedAfterConsumption).toBe(true);
  });

  it("rejects cancelled and unknown invocations before executing any hook", async () => {
    const service = createHookService({ ...defaults, registrations: new Map() });
    await expect(service.invoke("missing", null, invokeOptions())).rejects.toThrow("Unknown hook");
    const controller = new AbortController();
    const reason = new Error("Hook cancelled");
    controller.abort(reason);
    await expect(
      service.invoke("missing", null, { ...invokeOptions(), signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("terminates an admitted command on abort and waits for its disposal", async () => {
    const admitted = Promise.withResolvers<void>();
    const finishDisposal = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<{ exitCode: number; signal: number; coreDumped: boolean }>();
    const controller = new AbortController();
    let disposed = 0;
    let outputController!: ReadableStreamDefaultController<Uint8Array>;
    const service = createHookService({
      ...defaults,
      registrations: new Map([
        [
          "cancel",
          {
            ...context,
            kind: "command",
            command: {
              executable: "/bin/bash",
              argv: ["bash", "-c", "read x"],
            },
          },
        ],
      ]),
      commands: {
        exec: async () => {
          admitted.resolve();
          return {
            stdin: new WritableStream(),
            stdout: new ReadableStream({
              start(stream) {
                outputController = stream;
              },
            }),
            stderr: empty(),
            exited: exit.promise,
            signal: notUsed,
            dispose: async () => {
              disposed++;
              await finishDisposal.promise;
              outputController.close();
              exit.resolve({ exitCode: 137, signal: 9, coreDumped: false });
            },
          };
        },
      },
    });
    const reason = new Error("Stop this hook");
    const pending = service.invoke("cancel", null, {
      ...invokeOptions(),
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await admitted.promise;
    controller.abort(reason);
    finishDisposal.resolve();
    await rejected;
    expect(disposed).toBe(1);
  });
});

function scriptRegistration(): Map<string, HookRegistration> {
  return new Map([
    [
      "script",
      {
        ...context,
        kind: "script",
        program: {
          id: "hook-script",
          mainModule: "main.js",
          modules: {
            "main.js": "export default {fetch(){return Response.json({continue:true})}}",
          },
        },
      },
    ],
  ]);
}
