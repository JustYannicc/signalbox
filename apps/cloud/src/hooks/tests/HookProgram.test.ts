import { describe, expect, it, vi } from "vite-plus/test";
import {
  KERNEL_HOOK_EXECUTABLE,
  KERNEL_HOOK_MAX_INPUT_BYTES,
  type KernelHookInvoker,
} from "../HookProgram.ts";
import {
  bytes,
  collect,
  deferred,
  prepare,
  readAll,
  setup,
  spawn,
  writeInput,
} from "./hookProgramFixture.ts";

describe("registered kernel hook program", () => {
  it("passes parsed official JSON and exact context, preserves output bytes and callback status", async () => {
    const payload = { event: "pre-tool-use", input: "Grüezi 🌍", nested: [1, true, null] };
    const expectedExit = { exitCode: 17, signal: 11, coreDumped: true };
    const invoke = vi.fn<KernelHookInvoker>(async () => ({
      stdout: bytes("stdout: café\n"),
      stderr: bytes("stderr: 雪\n"),
      exit: expectedExit,
    }));
    const test = setup(invoke);
    const piped = prepare(test, undefined, "/work");
    const child = spawn(test, piped, ["display-name-is-ignored", "opaque/id 1"], {
      PATH: "/usr/bin",
      HOOK_CONTEXT: "exact",
    });

    try {
      await writeInput(piped.stdin, bytes(`${JSON.stringify(payload)}\n`));
      const result = await collect(test, piped, child);
      expect(result.exited).toEqual({ status: "ok", value: expectedExit });
      expect(result.stdout).toEqual(bytes("stdout: café\n"));
      expect(result.stderr).toEqual(bytes("stderr: 雪\n"));
      expect(invoke).toHaveBeenCalledWith(
        "opaque/id 1",
        payload,
        expect.objectContaining({
          cwd: "/work",
          env: { PATH: "/usr/bin", HOOK_CONTEXT: "exact" },
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      await test.close(piped);
    }
  });

  it("uses full argv through KernelCommandExecutor and treats argv[0] as an alias", async () => {
    const invoke = vi.fn<KernelHookInvoker>(async () => ({
      stdout: bytes("ok"),
      stderr: new Uint8Array(),
      exit: { exitCode: 0, signal: 0, coreDumped: false },
    }));
    const test = setup(invoke);
    const signal = new AbortController().signal;

    try {
      const child = await test.executor.spawn(
        {
          executable: KERNEL_HOOK_EXECUTABLE,
          argv: ["argv0-alias", "registered-id"],
          cwd: "/work",
          env: { HOOK_CONTEXT: "executor" },
        },
        signal,
      );
      const writer = child.stdin.getWriter();
      await writer.write(bytes('{"official":true}\n'));
      await writer.close();
      writer.releaseLock();
      const [stdout, stderr, exited] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      expect({ stdout, stderr, exited }).toEqual({
        stdout: bytes("ok"),
        stderr: new Uint8Array(),
        exited: { exitCode: 0, signal: 0, coreDumped: false },
      });
      expect(invoke).toHaveBeenCalledWith(
        "registered-id",
        { official: true },
        expect.objectContaining({
          cwd: "/work",
          env: { HOOK_CONTEXT: "executor" },
          signal: expect.any(AbortSignal),
        }),
      );
      await child.dispose();
    } finally {
      await test.close();
    }
  });

  it("reads partial UTF-8 input through EOF before invoking the handler", async () => {
    const payload = { text: "split 🌍 payload" };
    const invoke = vi.fn<KernelHookInvoker>(async (_id, received) => ({
      stdout: bytes(JSON.stringify(received)),
      stderr: new Uint8Array(),
      exit: { exitCode: 0, signal: 0, coreDumped: false },
    }));
    const test = setup(invoke);
    const piped = prepare(test);
    const stdin = piped.prepared.filesystem.descriptors.get(0).stdio!;
    const readStarted = deferred();
    const partialRead = deferred();
    const originalRead = stdin.readInto!.bind(stdin);
    vi.spyOn(stdin, "readInto").mockImplementation((target, flags) => {
      readStarted.resolve();
      const result = originalRead(target, flags);
      if (result instanceof Promise) {
        return result.then((count) => {
          if (count > 0) partialRead.resolve();
          return count;
        });
      }
      if (result > 0) partialRead.resolve();
      return result;
    });
    const child = spawn(test, piped);

    try {
      await readStarted.promise;
      expect(test.wakes.size).toBeGreaterThan(0);
      const input = bytes(`${JSON.stringify(payload)}\n`);
      const splitAt = input.indexOf(0xf0) + 2;
      expect(splitAt).toBeGreaterThan(1);
      const writer = piped.stdin.getWriter();
      await writer.write(input.subarray(0, splitAt));
      await partialRead.promise;
      expect(invoke).not.toHaveBeenCalled();
      await writer.write(input.subarray(splitAt));
      await writer.close();
      writer.releaseLock();

      const result = await collect(test, piped, child);
      expect(result.exited).toMatchObject({ status: "ok", value: { exitCode: 0 } });
      expect(result.stdout).toEqual(bytes(JSON.stringify(payload)));
      expect(invoke).toHaveBeenCalledWith("hook-id", payload, expect.any(Object));
    } finally {
      await test.close(piped);
    }
  });

  it("retries partial output after pipe backpressure and preserves every byte", async () => {
    const stdout = Uint8Array.from({ length: 180_000 }, (_, index) => (index * 31) % 256);
    const invoke = vi.fn<KernelHookInvoker>(async () => ({
      stdout,
      stderr: bytes("warning\n"),
      exit: { exitCode: 0, signal: 0, coreDumped: false },
    }));
    const test = setup(invoke);
    const piped = prepare(test);
    const child = spawn(test, piped);
    const stream = piped.prepared.filesystem.descriptors.get(1).stdio!;
    const blockedWrite = deferred();
    const originalWrite = stream.write!.bind(stream);
    vi.spyOn(stream, "write").mockImplementation((chunk, flags) => {
      const result = originalWrite(chunk, flags);
      if (result instanceof Promise) {
        let settled = false;
        void result.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        queueMicrotask(() => {
          if (!settled) blockedWrite.resolve();
        });
      }
      return result;
    });

    try {
      await writeInput(piped.stdin, bytes("{}"));
      await blockedWrite.promise;
      const result = await collect(test, piped, child);
      expect(result.exited).toMatchObject({ status: "ok", value: { exitCode: 0 } });
      expect(result.stdout).toEqual(stdout);
      expect(result.stderr).toEqual(bytes("warning\n"));
    } finally {
      await test.close(piped);
    }
  });

  it("rejects malformed or oversized JSON without calling the handler", async () => {
    const invoke = vi.fn<KernelHookInvoker>();

    for (const input of [
      bytes("{broken"),
      new Uint8Array(KERNEL_HOOK_MAX_INPUT_BYTES + 1).fill(0x20),
    ]) {
      const test = setup(invoke);
      const piped = prepare(test);
      const child = spawn(test, piped);
      try {
        let result: Awaited<ReturnType<typeof collect>>;
        if (input.byteLength > KERNEL_HOOK_MAX_INPUT_BYTES) {
          const writer = piped.stdin.getWriter();
          const sending = writer.write(input).then(
            () => undefined,
            () => undefined,
          );
          result = await collect(test, piped, child);
          await sending;
          writer.releaseLock();
          expect(result.stderr).toEqual(
            bytes(`signalbox-hook: stdin exceeds ${KERNEL_HOOK_MAX_INPUT_BYTES} bytes\n`),
          );
        } else {
          await writeInput(piped.stdin, input);
          result = await collect(test, piped, child);
          expect(result.stderr).toEqual(
            bytes("signalbox-hook: stdin must contain one UTF-8 JSON value\n"),
          );
        }
        expect(result.exited).toMatchObject({ status: "ok", value: { exitCode: 2 } });
      } finally {
        await test.close(piped);
      }
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns usage for anything other than one operand after argv[0]", async () => {
    const invoke = vi.fn<KernelHookInvoker>();
    const test = setup(invoke);
    const piped = prepare(test);
    const child = spawn(test, piped, ["alias", "id", "extra"]);

    try {
      const result = await collect(test, piped, child);
      expect(result.exited).toMatchObject({ status: "ok", value: { exitCode: 2 } });
      expect(result.stderr).toEqual(bytes("Usage: signalbox-hook <id>\n"));
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await test.close(piped);
    }
  });

  it("cancels a blocked stdin read and releases its descriptor wake", async () => {
    const invoke = vi.fn<KernelHookInvoker>();
    const test = setup(invoke);
    const piped = prepare(test);
    const stdin = piped.prepared.filesystem.descriptors.get(0).stdio!;
    const readStarted = deferred();
    const originalRead = stdin.readInto!.bind(stdin);
    vi.spyOn(stdin, "readInto").mockImplementation((target, flags) => {
      readStarted.resolve();
      return originalRead(target, flags);
    });
    const child = spawn(test, piped);

    try {
      await readStarted.promise;
      expect(test.wakes.size).toBeGreaterThan(0);
      expect(test.host.processes.signal(child, 15).status).toBe("ok");
      const result = await collect(test, piped, child);
      expect(result.exited).toEqual({
        status: "ok",
        value: { exitCode: 0, signal: 15, coreDumped: false },
      });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await test.close(piped);
    }
  });

  it("reports handler failures without leaking the thrown error", async () => {
    const invoke = vi.fn<KernelHookInvoker>(async () => {
      throw new Error("private handler details");
    });
    const test = setup(invoke);
    const piped = prepare(test);
    const child = spawn(test, piped);

    try {
      await writeInput(piped.stdin, bytes("null\n"));
      const result = await collect(test, piped, child);
      expect(result.exited).toMatchObject({ status: "ok", value: { exitCode: 1 } });
      expect(result.stderr).toEqual(bytes("signalbox-hook: hook handler failed\n"));
    } finally {
      await test.close(piped);
    }
  });
});
