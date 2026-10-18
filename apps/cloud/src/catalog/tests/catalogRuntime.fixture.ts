import { HomeObject as CatalogHomeObject } from "../HomeObject.ts";
import type { ShardDOState } from "lunorash/do";
import type { ScheduleRecord } from "@lunora/scheduler";
import { CatalogScheduler as NativeCatalogScheduler } from "../catalogScheduler.ts";

let recoveryPaused = true;
export class CatalogScheduler extends NativeCatalogScheduler {
  protected override dispatch(record: ScheduleRecord) {
    return recoveryPaused ? Promise.resolve(false) : super.dispatch(record);
  }
}

export class HomeObject extends CatalogHomeObject {
  private readonly testStorage: DurableObjectStorage;
  private acknowledgments = 0;
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
          if (this.acknowledgments < count) return;
          this.acknowledgmentWaiters.delete(check);
          resolve(new Response(null, { status: 204 }));
        };
        this.acknowledgmentWaiters.add(check);
        check();
      });
    }
    if (path === "/_lunora/delivery-fence" && (await this.testStorage.get("test:block-fences"))) {
      return new Response("Injected fence installation failure", { status: 503 });
    }
    const envelope: unknown = path === "/rpc" ? await request.clone().json() : null;
    const response = await super.fetch(request);
    if (
      path === "/_lunora/delivery-fence" &&
      response.status === 204 &&
      (await this.testStorage.get("test:lose-fence-ack"))
    ) {
      return new Response("Injected loss after native fence commit", { status: 503 });
    }
    if (
      response.status === 200 &&
      typeof envelope === "object" &&
      envelope !== null &&
      "functionPath" in envelope &&
      envelope.functionPath === "personalRecovery:sync_acknowledgeFence"
    ) {
      this.acknowledgments++;
      for (const check of this.acknowledgmentWaiters) check();
    }
    return response;
  }
}

export default {
  fetch: (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/test/recovery/pause" || path === "/test/recovery/resume") {
      recoveryPaused = path.endsWith("pause");
      return new Response(null, { status: 204 });
    }
    return new Response("No public Catalog route", { status: 404 });
  },
};
