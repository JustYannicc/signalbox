import { ProductFixtureFilesStore as HarnessFilesStoreObject } from "./productStores.workerd.fixture.ts";
import { ProductFixtureRunStore } from "./productStores.workerd.fixture.ts";
import { HarnessThreadSupervisorObject } from "../../../HarnessThreadSupervisorObject.ts";
import { HarnessProcessExecutionShardObject } from "../../../HarnessProcessExecutionShardObject.ts";
import { HarnessProcessPlacementStoreObject } from "../../../HarnessProcessPlacementStoreObject.ts";
import type { ProductWorkerEnv } from "./productBindings.workerd.fixture.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../../../HarnessCProductCapabilities.ts";
import { ProductFixtureCapability } from "./productCapability.workerd.fixture.ts";
import { ProductFixtureExecutor } from "./productExecutor.workerd.fixture.ts";
import { runProductScenario } from "./productScenario.workerd.fixture.ts";

export {
  HarnessFilesStoreObject,
  ProductFixtureRunStore,
  HarnessThreadSupervisorObject,
  ProductFixtureCapability,
  ProductFixtureExecutor,
};

export class ProductFixtureShard extends HarnessProcessExecutionShardObject {
  constructor(ctx: DurableObjectState, env: ProductWorkerEnv) {
    const name = "product-fixture";
    const capabilities = env.PRODUCT_FIXTURE.getByName(name) as unknown as Fetcher;
    const executor = env.PRODUCT_EXECUTOR.getByName(name) as unknown as Fetcher;
    super(ctx, {
      ...env,
      HARNESS_C_PRODUCT_CAPABILITIES: {
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.release]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.access]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.model]: capabilities,
        [HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor]: executor,
      },
    });
  }

  async evidence() {
    const terminal = await this.ctx.storage.list<{
      readonly stopped: boolean;
      readonly joined: {
        readonly invocationRpc: boolean;
        readonly fetch: boolean;
        readonly ports: boolean;
      };
      readonly request?: { readonly requestId: string };
    }>({ prefix: "harness-process-terminal/v1/" });
    const resumes = await this.ctx.storage.list<{
      readonly phase: string;
      readonly prepared?: unknown;
      readonly failure?: unknown;
    }>({ prefix: "harness-process-resume/v1/" });
    return {
      terminal: [...terminal.values()].map((row) => ({
        stopped: row.stopped,
        joined: row.joined,
        requestId: row.request?.requestId,
      })),
      resumes: [...resumes.values()].map((row) => ({
        phase: row.phase,
        prepared: row.prepared !== undefined,
        failure: row.failure,
      })),
    };
  }
}

export class ProductFixturePlacementStore extends HarnessProcessPlacementStoreObject {
  async writerStatus(owner: string) {
    return { writer: (await this.readWriter(owner)) !== undefined };
  }
}

export default {
  async fetch(request: Request, env: ProductWorkerEnv) {
    try {
      const path = new URL(request.url).pathname;
      if (
        path !== "/positive" &&
        path !== "/codex-same" &&
        path !== "/mismatch" &&
        !path.startsWith("/failure/")
      )
        return Response.json({ error: "unknown scenario" }, { status: 404 });
      const mismatch = path === "/mismatch";
      return Response.json(
        await runProductScenario(
          env,
          mismatch,
          path.startsWith("/failure/") ? path.slice("/failure/".length) : undefined,
          path === "/codex-same" ? "codex" : "claude-code",
        ),
      );
    } catch (cause) {
      const errors = [];
      for (let error: unknown = cause, i = 0; error !== undefined && i < 8; i++) {
        errors.push(
          error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        );
        error = error instanceof Error ? error.cause : undefined;
      }
      const observations = await env.PRODUCT_FIXTURE.getByName("product-fixture").observations();
      return new Response(JSON.stringify({ errors, observations }), { status: 500 });
    }
  },
};
