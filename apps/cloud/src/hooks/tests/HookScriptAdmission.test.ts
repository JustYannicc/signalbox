import { expect, it } from "vite-plus/test";
import { ChildWorkerCapacity } from "../../computer/ChildWorkerCapacity.ts";
import { createHookService } from "../HookService.ts";
import { bytes, readAll, setup, spawn, writeInput } from "./hookProgramFixture.ts";

it("runs a script hook while its invoking shell holds the one-slot pool", async () => {
  const capacity = new ChildWorkerCapacity(1);
  const controller = new AbortController();
  const attempted = Promise.withResolvers<void>();
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
    generated: { invoke: async () => new Response("script ran") },
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
    async () => {
      piped = test.host.preparePiped(
        { filesystem: test.filesystem, parent: shell.value.handle, signal: controller.signal },
        { cwd: "/work" },
      );
      const child = spawn(test, piped, ["signalbox-hook", "script"]);
      await writeInput(piped.stdin, bytes("{}\n"));
      const [stdout, stderr, exited] = await Promise.all([
        readAll(piped.stdout),
        readAll(piped.stderr),
        test.host.exitStatus(child),
      ]);
      expect(test.host.reap(child).status).toBe("ok");
      return { stdout, stderr, exited };
    },
    { processes: test.host.processes, process: shell.value.handle },
  );
  void running.catch(() => undefined);
  try {
    await attempted.promise;
    expect(capacity.active).toBe(2);
    const result = await running;
    expect(result.exited).toMatchObject({ status: "ok", value: { exitCode: 0 } });
    expect(result.stdout).toEqual(bytes("script ran"));
    expect(capacity.active).toBe(0);
  } finally {
    controller.abort();
    await running.catch(() => undefined);
    shellExit.resolve({ exitCode: 0, signal: 0, coreDumped: false });
    await test.close(piped);
  }
});
