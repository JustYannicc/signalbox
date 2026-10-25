import { DurableObject } from "cloudflare:workers";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createKernelSessionStdio } from "../../kernel/KernelSessionStdio.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { KernelProgramRegistry, kernelError, kernelOk } from "../../kernel/KernelAbi.ts";
import type { KernelCommandChild, KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";
import { createNodeComputerChildProcess } from "../../isolate/NodeComputerProcess.ts";
import { createComputerForwardedProgram } from "../ComputerForwardedProgram.ts";

export class InputCancellation extends DurableObject {
  private readonly unhandled: string[] = [];
  private result: Record<string, unknown> | undefined;
  private readonly onUnhandled = (event: Event) => {
    const reason: unknown = Reflect.get(event, "reason");
    this.unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };

  async run(kind: string) {
    const wakes = new KernelWakeRegistry();
    const stdio = createKernelSessionStdio(wakes);
    const files = new KernelFileSystem({
      mounts: [{ path: "/", storage: createFacetSqliteStorage(this.ctx.storage, () => 1n) }],
      stdio: stdio.stdio,
    });
    stdio.assertBound(files);
    const host = new KernelProgramHost({ wakes, registry: new KernelProgramRegistry() });
    const blocked = Promise.withResolvers<void>();
    const endpoint = stdio.stdio[0];
    const poll = endpoint.poll;
    if (poll === undefined) throw new Error("Expected a pollable stdin descriptor");
    let enteredReadPoll = false;
    endpoint.poll = (direction, signal) => {
      const result = poll(direction, signal);
      if (direction === "read") {
        enteredReadPoll = true;
        blocked.resolve();
      }
      return result;
    };
    const exit = { exitCode: 7, signal: 0, coreDumped: false };
    let disposed = false;
    const child: KernelCommandChild = {
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream({ start: (stream) => stream.close() }),
      stderr: new ReadableStream({ start: (stream) => stream.close() }),
      exited: blocked.promise.then(() => exit),
      signal: async () => kernelOk(undefined),
      dispose: async () => {
        disposed = true;
      },
    };
    globalThis.addEventListener("unhandledrejection", this.onUnhandled);
    try {
      let result: KernelCommandExit;
      if (kind === "node") {
        const process = createNodeComputerChildProcess(
          host,
          { filesystem: files, env: {} },
          { exec: async () => child },
        );
        const running = process.spawn("controlled-tool", [], { stdio: "inherit" });
        result = await new Promise<KernelCommandExit>((resolve, reject) => {
          running.once("error", reject);
          running.once("close", (exitCode) =>
            resolve({ exitCode: exitCode ?? -1, signal: 0, coreDumped: false }),
          );
        });
      } else {
        const command = {
          executable: "/bin/controlled-tool",
          argv: ["controlled-tool"],
          cwd: files.cwd,
          env: {},
        };
        const admitted = host.processes.spawn(
          undefined,
          (identity) => ({
            completion: createComputerForwardedProgram({ spawn: async () => child }, command).run({
              filesystem: files,
              identity,
              processes: host.processes,
              wakes,
              signal: new AbortController().signal,
              home: undefined,
              args: command.argv,
              env: command.env,
              spawn: async () => kernelError("UNSUPPORTED", "This command does not spawn"),
              exec: async () => {
                throw new Error("This command does not exec");
              },
            }),
            signal: () => kernelOk(undefined),
          }),
          () => {},
        );
        if (admitted.status !== "ok")
          throw new Error(`Process admission failed: ${admitted.status}`);
        const completed = await host.exitStatus(admitted.value.handle);
        if (completed.status !== "ok")
          throw new Error(`Process completion failed: ${completed.status}`);
        result = completed.value;
      }
      const borrowedInputOpen = files.descriptors.has(0);
      await stdio.dispose();
      this.result = {
        enteredReadPoll,
        exitCode: result.exitCode,
        signal: result.signal,
        disposed,
        borrowedInputOpen,
        wakes: wakes.size,
      };
    } finally {
      await host.processes.dispose();
      await stdio.dispose();
      files.dispose();
      wakes.dispose();
    }
  }

  finish() {
    globalThis.removeEventListener("unhandledrejection", this.onUnhandled);
    if (this.result === undefined) throw new Error("The command has not completed");
    return { ...this.result, unhandled: this.unhandled };
  }
}

export default {
  async fetch(request: Request, env: { INPUTS: DurableObjectNamespace<InputCancellation> }) {
    const kind = new URL(request.url).pathname.slice(1);
    const object = env.INPUTS.get(env.INPUTS.idFromName(kind));
    if (request.method === "POST") {
      await object.run(kind);
      return new Response("completed");
    }
    return Response.json(await object.finish());
  },
};
