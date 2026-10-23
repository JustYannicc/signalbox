import { DurableObject } from "cloudflare:workers";
import type { ComputerExecPort } from "../../computer/Computer.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { KernelProgramRegistry, kernelOk } from "../../kernel/KernelAbi.ts";
import type { KernelCommandChild, KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";
import { KernelWakeRegistry, type WakeSubscription } from "../../kernel/KernelWakeRegistry.ts";
import { createNodeComputerChildProcess } from "../NodeComputerProcess.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class PendingReadWakeRegistry extends KernelWakeRegistry {
  readonly #twoReads = deferred<void>();

  waitForTwoReads() {
    if (this.size >= 2) this.#twoReads.resolve(undefined);
    return this.#twoReads.promise;
  }

  override register(subscribe: WakeSubscription): ReturnType<KernelWakeRegistry["register"]> {
    const result = super.register(subscribe);
    if (this.size >= 2) this.#twoReads.resolve(undefined);
    return result;
  }
}

type OutputProgram = ReturnType<KernelProgramHost["preparePiped"]>;
type RecordedError = { name: string; message: string };

function descriptorCount(program: OutputProgram | undefined): number {
  return program === undefined ? 0 : [...program.prepared.filesystem.descriptors.entries()].length;
}

function errorRecord(error: Error): RecordedError {
  return { name: error.name, message: error.message };
}

export class NodeComputerOutputCancellation extends DurableObject {
  private result: Record<string, unknown> | undefined;
  private readonly unhandled: RecordedError[] = [];
  private readonly onUnhandled = (event: Event) => {
    const reason: unknown = Reflect.get(event, "reason");
    this.unhandled.push(
      reason instanceof Error
        ? errorRecord(reason)
        : { name: "UnknownRejection", message: String(reason) },
    );
    event.preventDefault();
  };

  async run(mode: string) {
    const destinationWakes = new PendingReadWakeRegistry();
    const sourceWakes = new PendingReadWakeRegistry();
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: createFacetSqliteStorage(this.ctx.storage, () => 1n) }],
    });
    const destinationHost = new KernelProgramHost({
      registry: new KernelProgramRegistry(),
      wakes: destinationWakes,
    });
    const sourceHost = new KernelProgramHost({
      registry: new KernelProgramRegistry(),
      wakes: sourceWakes,
    });
    const owner = new AbortController();
    const exited = deferred<KernelCommandExit>();
    let sourceProgram: OutputProgram | undefined;
    let destinationProgram: OutputProgram | undefined;
    let disposed = false;
    const computer: ComputerExecPort = {
      async exec(command, signal) {
        if (command.executable !== "/bin/rg") throw new Error("Unexpected controlled command");
        sourceProgram = sourceHost.preparePiped({ filesystem, signal });
        const program = sourceProgram;
        const child: KernelCommandChild = {
          stdin: program.stdin,
          stdout: program.stdout,
          stderr: program.stderr,
          exited: exited.promise,
          async signal(number) {
            exited.resolve({ exitCode: 0, signal: number, coreDumped: false });
            return kernelOk(undefined);
          },
          async dispose() {
            if (disposed) return;
            disposed = true;
            exited.resolve({ exitCode: 0, signal: 15, coreDumped: false });
            await program.prepared.release();
          },
        };
        return child;
      },
    };

    const prepareDestination = destinationHost.preparePiped.bind(destinationHost);
    destinationHost.preparePiped = (...args) => {
      const program = prepareDestination(...args);
      destinationProgram = program;
      return program;
    };

    globalThis.addEventListener("unhandledrejection", this.onUnhandled);
    try {
      const child = createNodeComputerChildProcess(
        destinationHost,
        { filesystem, env: {}, signal: owner.signal },
        computer,
      ).spawn("/bin/rg", ["rg", "--version"]);
      const childErrors: RecordedError[] = [];
      child.on("error", (error: Error) => childErrors.push(errorRecord(error)));
      child.stdout?.resume();
      child.stderr?.resume();
      const closed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
        child.once("close", (exitCode: number | null, signal: string | null) =>
          resolve({ exitCode, signal }),
        );
      });

      await Promise.all([sourceWakes.waitForTwoReads(), destinationWakes.waitForTwoReads()]);
      const pendingReads = { source: sourceWakes.size, destination: destinationWakes.size };
      if (mode === "context-abort") owner.abort(new Error("controlled owner cancellation"));
      else if (!child.kill("SIGTERM")) throw new Error("Could not signal the admitted process");

      const close = await closed;
      await sourceHost.processes.dispose();
      await destinationHost.processes.dispose();
      const cleanup = {
        sourceDescriptors: descriptorCount(sourceProgram),
        destinationDescriptors: descriptorCount(destinationProgram),
        sourceWakeTokens: sourceWakes.size,
        destinationWakeTokens: destinationWakes.size,
        sourceProcesses: sourceHost.processes.size,
        destinationProcesses: destinationHost.processes.size,
        baseDescriptorsBeforeDispose: [...filesystem.descriptors.entries()].length,
      };
      filesystem.dispose();
      this.result = {
        command: "/bin/rg",
        pendingReads,
        close,
        childErrors,
        disposed,
        cleanup: {
          ...cleanup,
          baseDescriptorsAfterDispose: [...filesystem.descriptors.entries()].length,
        },
      };
    } finally {
      owner.abort(new Error("fixture cleanup"));
      await destinationHost.processes.dispose();
      await sourceHost.processes.dispose();
      await destinationProgram?.prepared.release();
      await sourceProgram?.prepared.release();
      filesystem.dispose();
      destinationWakes.dispose();
      sourceWakes.dispose();
    }
  }

  finish() {
    globalThis.removeEventListener("unhandledrejection", this.onUnhandled);
    if (this.result === undefined)
      throw new Error("The output cancellation case has not completed");
    return { ...this.result, unhandled: this.unhandled };
  }
}

export default {
  async fetch(
    request: Request,
    env: { OUTPUTS: DurableObjectNamespace<NodeComputerOutputCancellation> },
  ) {
    const mode = new URL(request.url).pathname.slice(1);
    const object = env.OUTPUTS.get(env.OUTPUTS.idFromName(mode));
    if (request.method === "POST") {
      await object.run(mode);
      return new Response("completed");
    }
    return Response.json(await object.finish());
  },
};
