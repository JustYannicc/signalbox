import { DurableObject } from "cloudflare:workers";
import {
  createHarnessCProductTurnGrantSource,
  productTurnGrantSource,
  type HarnessCProductTurnGrantInput,
} from "../../HarnessCProductCapabilities.ts";
import type { HarnessMcpTurnGrantInput } from "../../HarnessSessionHost.ts";

export class TurnGrantService extends DurableObject {
  readonly #started = Promise.withResolvers<void>();
  #stopped = false;

  issue(input: HarnessCProductTurnGrantInput) {
    return createHarnessCProductTurnGrantSource<string>({
      issue: (localInput) => this.issueLocal(localInput),
    }).issue(input);
  }

  private async issueLocal(input: HarnessMcpTurnGrantInput) {
    if (input.runId === "success") {
      return {
        grant: JSON.stringify({
          runId: input.runId,
          nativeTurnEpoch: input.nativeTurnEpoch,
          publisher: input.publisher,
        }),
        endpoint: "https://tools-gateway.test/mcp",
        expiresAtMs: 123456789,
      };
    }
    this.#started.resolve();
    try {
      await new Promise<never>((_resolve, reject) => {
        if (input.signal.aborted) reject(input.signal.reason);
        else
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    } finally {
      this.#stopped = true;
    }
    return null;
  }

  async waitForStart() {
    await this.#started.promise;
  }

  stopped() {
    return this.#stopped;
  }
}

interface Env {
  readonly TURN_GRANTS: DurableObjectNamespace<TurnGrantService>;
}

export default {
  async fetch(_request: Request, env: Env) {
    const service = env.TURN_GRANTS.getByName("issuance");
    const source = productTurnGrantSource<string>(service);
    const publisher = { generation: 7, facetNonce: "publisher-a" };
    const success = await source.issue({
      runId: "success",
      nativeTurnEpoch: 2,
      publisher,
      signal: new AbortController().signal,
    });
    const controller = new AbortController();
    const issuance = source
      .issue({
        runId: "cancel",
        nativeTurnEpoch: 3,
        publisher,
        signal: controller.signal,
      })
      .then(
        () => ({ aborted: false, message: "Unexpected success" }),
        (cause: unknown) => ({
          aborted: true,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    await Promise.race([
      service.waitForStart(),
      issuance.then((result) => {
        throw new Error("Issuance settled before remote start: " + result.message);
      }),
    ]);
    controller.abort(new Error("turn retired"));
    return Response.json({ success, cancelled: await issuance, stopped: await service.stopped() });
  },
};
