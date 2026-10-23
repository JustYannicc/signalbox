import { expect, it } from "vite-plus/test";
import { ChildWorkerCapacity } from "../../computer/ChildWorkerCapacity.ts";
import { createHookService } from "../HookService.ts";
import { bytes, readAll, setup, spawn, writeInput } from "./hookProgramFixture.ts";

const syntheticRequest = Object.freeze({ codeId: "test-holder", residentBytes: 0 });

it("runs a script hook after its invoking shell acknowledges stop", async () => {
  const capacity = new ChildWorkerCapacity(1);
  const controller = new AbortController();
  const attempted = Promise.withResolvers<void>();
  const stopAck = Promise.withResolvers<void>();
  const scriptStarted = Promise.withResolvers<void>();
  const scriptResponse = Promise.withResolvers<Response>();
  const shellExit = Promise.withResolvers<{
    exitCode: number;
    signal: number;
    coreDumped: boolean;
  }>();
  const hooks = createHookService({
    registrations: new Map([
      [
        "script",
        {
          harness: "claude-code",
          event: "pre-tool-use",
          sessionId: "session",
          kind: "script",
          program: {
            id: "script",
            mainModule: "hook.js",
            modules: { "hook.js": "export default {}" },
          },
        },
      ],
    ]),
    commands: {
      exec: async () => {
        throw new Error("Wrong hook route");
      },
    },
    generated: {
      invoke: async () => {
        scriptStarted.resolve();
        return scriptResponse.promise;
      },
    },
    capacity: {
      acquire(signal, requester) {
        const pending = capacity.acquire(signal, requester);
        attempted.resolve();
        return pending;
      },
    },
  });
  const test = setup((id, payload, invocation) => hooks.invoke(id, payload, invocation));
  const shell = test.host.processes.spawn(
    undefined,
    () => ({
      completion: shellExit.promise,
      signal: () => ({ status: "ok", value: undefined }),
    }),
    () => {},
  );
  if (shell.status !== "ok") throw new Error("Hook shell did not start");
  let piped: ReturnType<typeof test.host.preparePiped> | undefined;
  const running = capacity.run(
    controller.signal,
    async (execution) => {
      piped = test.host.preparePiped(
        { filesystem: test.filesystem, parent: shell.value.handle, signal: controller.signal },
        { cwd: "/work" },
      );
      const child = spawn(test, piped, ["signalbox-hook", "script"]);
      await writeInput(piped.stdin, bytes("{}\n"));
      await attempted.promise;
      // The test driver acknowledges stop after the script admission request is queued.
      await stopAck.promise;
      await execution.handoff();
      await scriptStarted.promise;
      const [stdout, stderr, exited] = await Promise.all([
        readAll(piped.stdout),
        readAll(piped.stderr),
        test.host.exitStatus(child),
      ]);
      expect(test.host.reap(child).status).toBe("ok");
      return { stdout, stderr, exited };
    },
    { processes: test.host.processes, process: shell.value.handle },
    syntheticRequest,
  );
  void running.catch(() => undefined);
  try {
    await attempted.promise;
    stopAck.resolve();
    await scriptStarted.promise;
    expect(capacity.active).toBe(1);
    scriptResponse.resolve(new Response("script ran"));
    const result = await running;
    expect(result.exited).toMatchObject({ status: "ok", value: { exitCode: 0 } });
    expect(result.stdout).toEqual(bytes("script ran"));
    expect(capacity.active).toBe(0);
  } finally {
    controller.abort();
    stopAck.resolve();
    scriptResponse.resolve(new Response("script ran"));
    await running.catch(() => undefined);
    shellExit.resolve({ exitCode: 0, signal: 0, coreDumped: false });
    await test.close(piped);
  }
});
