import { HomeObject as CatalogHomeObject } from "../HomeObject.ts";
import type { ShardDOState } from "lunorash/do";
import type { ScheduleRecord } from "@lunora/scheduler";
import {
  CatalogScheduler as NativeCatalogScheduler,
  type CatalogSchedulerEnv,
} from "../catalogScheduler.ts";

export class CatalogScheduler extends NativeCatalogScheduler {
  private gate: ReturnType<typeof Promise.withResolvers<void>> | undefined =
    Promise.withResolvers<void>();
  private readonly active = new Set<Promise<boolean | "in-progress">>();

  protected override async dispatch(record: ScheduleRecord) {
    while (this.gate !== undefined) await this.gate.promise;
    const pending = super.dispatch(record);
    this.active.add(pending);
    try {
      return await pending;
    } finally {
      this.active.delete(pending);
    }
  }

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/test/pause") {
      this.gate ??= Promise.withResolvers<void>();
      await Promise.all(this.active);
      return new Response(null, { status: 204 });
    }
    if (path === "/test/resume") {
      const gate = this.gate;
      this.gate = undefined;
      gate?.resolve();
      return new Response(null, { status: 204 });
    }
    return super.fetch(request);
  }
}

export class HomeObject extends CatalogHomeObject {
  private readonly testStorage: DurableObjectStorage;
  private readonly acknowledgments = new Set<string>();
  private readonly acknowledgmentWaiters = new Set<() => void>();

  constructor(state: ShardDOState, env: unknown) {
    super(state, env);
    this.testStorage = (state as ShardDOState & DurableObjectState).storage;
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/test/fence-failure") {
      await this.testStorage.put("test:block-fences", request.method === "POST");
      return new Response(null, { status: 204 });
    }
    if (path === "/test/lost-fence-ack") {
      await this.testStorage.put("test:lose-fence-ack", request.method === "POST");
      return new Response(null, { status: 204 });
    }
    if (path === "/test/epochs") {
      const record = await this.testStorage.get<{ installedEpoch: number }>("catalog:home:v1");
      const native = this.testStorage.sql
        .exec<{ epoch: number | null }>("SELECT MAX(epoch) AS epoch FROM __lunora_delivery_fence")
        .one();
      return Response.json({
        savedEpoch: record?.installedEpoch ?? 0,
        nativeEpoch: native.epoch ?? 0,
      });
    }
    if (path === "/test/wait-fence-ack") {
      const count = Number(url.searchParams.get("count"));
      if (!Number.isSafeInteger(count) || count < 1) return new Response(null, { status: 400 });
      return new Promise<Response>((resolve) => {
        const check = () => {
          if (this.acknowledgments.size < count) return;
          this.acknowledgmentWaiters.delete(check);
          resolve(new Response(null, { status: 204 }));
        };
        this.acknowledgmentWaiters.add(check);
        check();
      });
    }
    if (path === "/_lunora/delivery-fence" && (await this.testStorage.get("test:block-fences"))) {
      return new Response(null, { status: 503 });
    }
    const envelope: unknown = path === "/rpc" ? await request.clone().json() : null;
    const response = await super.fetch(request);
    if (
      path === "/_lunora/delivery-fence" &&
      response.status === 204 &&
      (await this.testStorage.get("test:lose-fence-ack"))
    ) {
      return new Response(null, { status: 503 });
    }
    if (
      response.status === 200 &&
      typeof envelope === "object" &&
      envelope !== null &&
      "functionPath" in envelope &&
      envelope.functionPath === "personalRecovery:sync_acknowledgeFence" &&
      "args" in envelope &&
      typeof envelope.args === "object" &&
      envelope.args !== null &&
      "receipt" in envelope.args &&
      typeof envelope.args.receipt === "string"
    ) {
      this.acknowledgments.add(envelope.args.receipt);
      for (const check of this.acknowledgmentWaiters) check();
    }
    return response;
  }
}

export default {
  fetch: (request: Request, env: CatalogSchedulerEnv) => {
    const path = new URL(request.url).pathname;
    if (path === "/test/recovery/pause" || path === "/test/recovery/resume") {
      return env.CATALOG_SCHEDULER.get(env.CATALOG_SCHEDULER.idFromName("default")).fetch(
        new Request(`https://test/test/${path.endsWith("pause") ? "pause" : "resume"}`),
      );
    }
    return new Response("No public Catalog route", { status: 404 });
  },
};
