// @effect-diagnostics globalFetch:off - the native tail reports to a local test collector.
import {
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
  exports as hostExports,
} from "cloudflare:workers";
import { createCompiledChildWorkerLoader } from "../../src/computer/CompiledChildWorkerLoader.ts";
import { createWorkerLoaderDispatch } from "../../src/computer/WorkerLoaderDispatch.ts";
import { ChildWorkerDispatchError } from "../../src/computer/ChildWorkerDispatchError.ts";
import type { ChildWorkerInvocation } from "../../src/computer/ChildWorkerProgram.ts";

interface Env {
  LOADER: WorkerLoader;
  PROBE: DurableObjectNamespace<ChildInvocationProbe>;
  REPORT_URL: string;
}

const loopback = hostExports as {
  ChildInvocationTail: LoopbackServiceStub<ChildInvocationTail>;
  ChildInvocationLoader: LoopbackServiceStub<ChildInvocationLoader>;
};

function observedLoader(loader: WorkerLoader): WorkerLoader {
  return {
    get(name, factory) {
      return loader.get(name, async () => ({
        ...(await factory()),
        tails: [loopback.ChildInvocationTail],
      }));
    },
    load: loader.load.bind(loader),
  };
}

class Host extends RpcTarget {
  readonly #ready: Promise<void> | undefined;
  readonly #entered: () => void;

  constructor(ready: Promise<void> | undefined, entered: () => void) {
    super();
    this.#ready = ready;
    this.#entered = entered;
  }

  async ping() {
    this.#entered();
    await this.#ready;
    return 7;
  }
}

const source = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async run(command, host) {
    const exitCode = await host.ping();
    if (command.argv[0] === "fail") throw new Error("expected child failure");
    return { exitCode, signal: 0, coreDumped: false };
  }
}`;

export class ChildInvocationLoader extends WorkerEntrypoint<Env> {
  async run(input: ChildWorkerInvocation, invocation: RpcTarget) {
    return createCompiledChildWorkerLoader(observedLoader(this.env.LOADER), new Map()).run(
      input,
      invocation,
    );
  }
}

export class ChildInvocationProbe extends DurableObject<Env> {
  readonly #completed = Promise.withResolvers<unknown>();
  readonly #released = Promise.withResolvers<void>();
  readonly #entered = Promise.withResolvers<void>();
  readonly #ready = Promise.withResolvers<void>();
  override async fetch(request: Request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/entered":
        await this.#entered.promise;
        return new Response("host call entered");
      case "/ready":
        this.#ready.resolve();
        return new Response("host call released");
      case "/completed":
        return Response.json(await this.#completed.promise);
      case "/release":
        this.#released.resolve();
        return new Response("released");
    }
    const dispatch = createWorkerLoaderDispatch<Host>(
      url.searchParams.get("loader") === "port"
        ? loopback.ChildInvocationLoader
        : observedLoader(this.env.LOADER),
    );
    try {
      const exit = await dispatch.run(
        {
          mainModule: "child.js",
          modules: { "child.js": source },
          command: {
            executable: "/bin/probe",
            argv: [url.searchParams.get("result") ?? "ok"],
            cwd: "/",
            env: {},
          },
        },
        new Host(url.searchParams.get("result") === "gated" ? this.#ready.promise : undefined, () =>
          this.#entered.resolve(),
        ),
      );
      this.#completed.resolve({ exit });
    } catch (error) {
      this.#completed.resolve({
        error: String(error),
        termination: error instanceof ChildWorkerDispatchError ? error.termination.kind : undefined,
      });
    }
    // Keep the caller's event alive. A returned RPC stub must not pin the finished child to it.
    await this.#released.promise;
    return new Response("parent completed");
  }
}

export class ChildInvocationTail extends WorkerEntrypoint<Env> {
  override async tail(events: readonly TraceItem[]) {
    await fetch(this.env.REPORT_URL, { method: "POST", body: JSON.stringify(events) });
  }
}

export default {
  fetch(request: Request, env: Env) {
    return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(request);
  },
};
