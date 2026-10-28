import { DurableObject } from "cloudflare:workers";
import {
  createHarnessCProductExecutorService,
  productExecutor,
  type HarnessCProductExecutorForwardInput,
} from "../../HarnessCProductCapabilities.ts";

export class ExecutorService extends DurableObject {
  readonly #started = Promise.withResolvers<void>();
  #stopped = false;
  #grant: string | undefined;
  #body: string | undefined;
  #requestAborted = false;

  async forward(input: HarnessCProductExecutorForwardInput<string>) {
    return createHarnessCProductExecutorService<string>({
      forward: async ({ signal, request, grant }) => {
        if (new URL(request.url).pathname === "/echo") {
          return new Response(await request.text(), {
            status: 202,
            statusText: "Accepted",
            headers: { "x-received": request.headers.get("x-sent") ?? "missing", "x-grant": grant },
          });
        }
        this.#grant = grant;
        this.#body = await request.text();
        this.#started.resolve();
        try {
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } finally {
          this.#stopped = true;
          this.#requestAborted = request.signal.aborted;
        }
        return new Response("unreachable");
      },
    }).forward(input);
  }

  async waitForStart() {
    await this.#started.promise;
  }

  observation() {
    return {
      stopped: this.#stopped,
      requestAborted: this.#requestAborted,
      grant: this.#grant,
      body: this.#body,
    };
  }
}

interface Env {
  readonly EXECUTOR: DurableObjectNamespace<ExecutorService>;
}

export default {
  async fetch(_request: Request, env: Env) {
    const service = env.EXECUTOR.getByName("executor-cancellation");
    const success = await productExecutor<string>(service).forward({
      target: { type: "executor" },
      grant: "success-grant",
      request: new Request("https://executor.invalid/echo", {
        method: "POST",
        headers: { "x-sent": "request-header" },
        body: "echo body",
      }),
      signal: new AbortController().signal,
    });
    const roundTrip = {
      status: success.status,
      statusText: success.statusText,
      received: success.headers.get("x-received"),
      grant: success.headers.get("x-grant"),
      body: await success.text(),
    };
    const controller = new AbortController();
    const forwarding = productExecutor<string>(service)
      .forward({
        target: { type: "executor" },
        grant: "fresh-legitimate-grant",
        request: new Request("https://executor.invalid/mcp", { method: "POST", body: "tool call" }),
        signal: controller.signal,
      })
      .then(
        () => ({ aborted: false, message: "Unexpected successful forward" }),
        (cause: unknown) => ({
          aborted: true,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    await Promise.race([
      service.waitForStart(),
      forwarding.then((result) => {
        throw new Error("Forward settled before entering executor: " + result.message);
      }),
    ]);
    controller.abort(new Error("local request cancelled"));
    const result = await forwarding;
    return Response.json({ roundTrip, result, remote: await service.observation() });
  },
};
export * from "../../../FixtureWorkerExports.ts";
