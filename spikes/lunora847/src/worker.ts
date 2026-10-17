import { html, clientJs } from "./assets.js";
import { createWorker } from "lunorash/runtime";
import { createShardDO } from "../lunora/_generated/shard.js";
import { openApiSpec } from "../lunora/_generated/openapi.js";
import { instrument } from "./instrumentation.js";
import type { ShardDOState } from "lunorash/do";
import { executions } from "../lunora/catalog.js";
type GeneratedInstance = InstanceType<ReturnType<typeof createShardDO>>;
// Codegen returns the abstract base type. Map its public methods to the concrete generated class.
const Base = createShardDO() as new (
  state: ShardDOState,
  env: unknown,
) => { [K in keyof GeneratedInstance]: GeneratedInstance[K] };
export class ShardDO extends Base {
  readonly bootId = crypto.randomUUID();
  private readonly snapshot;
  constructor(state: DurableObjectState, env: unknown) {
    const measured = instrument(state);
    super(measured.state as unknown as ShardDOState, env);
    this.snapshot = measured.snapshot;
  }
  fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (path === "/client.js")
      return new Response(clientJs, { headers: { "content-type": "text/javascript" } });
    if (new URL(request.url).pathname === "/spike/diagnostics")
      return Response.json({ bootId: this.bootId, executions, sql: this.snapshot() });
    return super.fetch(request);
  };
}
let worker: ReturnType<typeof createWorker> | undefined;
export default {
  async fetch(request: Request, env: { SHARD: DurableObjectNamespace }, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (path === "/client.js")
      return new Response(clientJs, { headers: { "content-type": "text/javascript" } });
    if (new URL(request.url).pathname === "/spike/diagnostics") {
      const stub = env.SHARD.get(env.SHARD.idFromName("__root__"));
      return stub.fetch(request);
    }
    worker ??= createWorker({
      openApiSpec,
      shardDO: {
        idFromName: (name: string) => env.SHARD.idFromName(name),
        get: (id: unknown) => env.SHARD.get(id as DurableObjectId),
      },
    });
    return worker.fetch(request, env, ctx);
  },
};
