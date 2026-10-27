// @effect-diagnostics globalFetch:off - native child tails report to the isolated local collector.
import { DurableObject, WorkerEntrypoint, exports as hostExports } from "cloudflare:workers";
import { ChildHostLease } from "../../src/computer/ChildHostLease.ts";
import { WorkerBashSnapshot } from "../../src/computer/WorkerBashSnapshot.ts";
import type { KernelBashForkSource } from "../../src/kernel/KernelBashFork.ts";

interface Env {
  LOADER: WorkerLoader;
  PROBE: DurableObjectNamespace<BashSnapshotProbe>;
  REPORT_URL: string;
}

const loopback = hostExports as {
  BashSnapshotTail: LoopbackServiceStub<BashSnapshotTail>;
};

const source = `import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
class Snapshot extends RpcTarget {
  state() { throw new Error("No heap needed for the lifetime reproduction"); }
  read() { throw new Error("No heap needed for the lifetime reproduction"); }
  restored() {}
}
export default class extends WorkerEntrypoint {
  open() { return new Snapshot(); }
}`;

interface Producer {
  open(): Promise<KernelBashForkSource & Disposable>;
}

export class BashSnapshotProbe extends DurableObject<Env> {
  readonly #restored = Promise.withResolvers<void>();
  readonly #released = Promise.withResolvers<void>();

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/restored") {
      await this.#restored.promise;
      return new Response("restored");
    }
    if (path === "/release") {
      this.#released.resolve();
      return new Response("released");
    }
    const producer = this.env.LOADER.get("bash-snapshot-lifetime", () => ({
      compatibilityDate: "2026-10-19",
      mainModule: "main.js",
      modules: { "main.js": source },
      tails: [loopback.BashSnapshotTail],
    })).getEntrypoint() as unknown as Producer;
    using snapshot = await producer.open();
    const lease = new ChildHostLease();
    const exported = new WorkerBashSnapshot(lease, snapshot);
    try {
      await exported.restored();
      this.#restored.resolve();
      // A restored source must not keep the producer alive until this caller event ends.
      await this.#released.promise;
    } finally {
      lease.release();
    }
    return new Response("finished");
  }
}

export class BashSnapshotTail extends WorkerEntrypoint<Env> {
  override async tail(events: readonly TraceItem[]) {
    await fetch(this.env.REPORT_URL, { method: "POST", body: JSON.stringify(events) });
  }
}

export default {
  fetch(request: Request, env: Env) {
    return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(request);
  },
};
