// @effect-diagnostics globalTimers:off globalConsole:off cryptoRandomUUID:off -- This is a plain Cloudflare Worker/DO boundary with no Effect runtime.
import { defineApp } from "./lunora/_generated/app.js";
import type { ShardDOState } from "lunorash/do";
import type { ShardNamespaceLike } from "lunorash/runtime";
import { createEvlogObservabilitySink } from "@signalbox/sync/adapters/evlog";
import { resolveProbeIdentity } from "./identity.js";
import { instrument } from "./instrumentation.js";

interface ProbeEnv {
  readonly PROBE_SECRET: string;
  readonly SHARD: DurableObjectNamespace;
}

const observability = createEvlogObservabilitySink(({ event }) => {
  console.log(JSON.stringify({ eventType: event.eventType, level: event.level }));
});

const app = defineApp<ProbeEnv>()
  .shard((env) => env.SHARD as unknown as ShardNamespaceLike)
  .observability(() => observability)
  .extend((env, derived) => ({
    ...derived,
    resolveIdentity: (request) => resolveProbeIdentity(request, env.PROBE_SECRET),
    authorizeShard: ({ identity, shardKey }) =>
      identity !== null && typeof identity.levelId === "string" && identity.levelId === shardKey,
    observability,
    routes: {
      ...derived.routes,
      "GET /_probe/metrics": async (request) => {
        const identity = await resolveProbeIdentity(request, env.PROBE_SECRET);
        if (identity === null) return new Response("unauthorized", { status: 401 });
        const id = env.SHARD.idFromName(identity.levelId);
        return env.SHARD.get(id).fetch("https://sync-probe.invalid/_probe/metrics");
      },
    },
  }))
  .build();

type GeneratedShard = Omit<InstanceType<typeof app.ShardDO>, "handleRpc"> & {
  handleRpc(
    functionPath: string,
    args: Record<string, unknown>,
    headroom?: Parameters<InstanceType<typeof app.ShardDO>["handleRpc"]>[2],
    scope?: Parameters<InstanceType<typeof app.ShardDO>["handleRpc"]>[3],
    bookmarks?: Parameters<InstanceType<typeof app.ShardDO>["handleRpc"]>[4],
  ): Promise<unknown>;
};
const ShardBase = app.ShardDO as new (state: ShardDOState, env: ProbeEnv) => GeneratedShard;

export class SyncProbeShard extends ShardBase {
  readonly bootId = crypto.randomUUID();
  private readonly sqlSnapshot: () => ReturnType<ReturnType<typeof instrument>["snapshot"]>;

  constructor(state: DurableObjectState, env: ProbeEnv) {
    const measured = instrument(state);
    super(measured.state as unknown as ShardDOState, env);
    this.sqlSnapshot = measured.snapshot;
  }

  override fetch = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === "/_probe/metrics") {
      return Response.json({ bootId: this.bootId, sql: this.sqlSnapshot() });
    }
    return super.fetch(request);
  };
}

export default app;
