import { DurableObject } from "cloudflare:workers";
import type { HarnessCProductExecutorForwardInput } from "../../../HarnessCProductCapabilities.ts";
import { createHarnessCProductExecutorService } from "../../../HarnessCProductCapabilities.ts";
import type { ProductFixtureGrant } from "./productGrant.workerd.fixture.ts";

export class ProductFixtureExecutor extends DurableObject {
  async forward(input: HarnessCProductExecutorForwardInput<ProductFixtureGrant>) {
    const service = createHarnessCProductExecutorService<ProductFixtureGrant>({
      forward: async ({ request, signal, grant }) => {
        signal.throwIfAborted();
        await this.ctx.storage.put("fixture/last-executor", {
          url: request.url,
          method: request.method,
          grant,
          body: request.body === null ? null : new Uint8Array(await request.arrayBuffer()),
        });
        return new Response("fixture executor response", { status: 200 });
      },
    });
    return await service.forward(input);
  }

  async observation() {
    return await this.ctx.storage.get("fixture/last-executor");
  }
}
