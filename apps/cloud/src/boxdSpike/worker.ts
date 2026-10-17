// @effect-diagnostics globalDate:off - Cloudflare alarms and request timings use the host wall clock.
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Probe from "./Probe.ts";
import { TokenCache } from "./TokenCache.ts";
import { makeSdkApi, sdkClient } from "./SdkApi.ts";
import { exchangeToken } from "./adapters/tokenExchange.ts";
import { handleProbe } from "./probeRoutes.ts";

interface Env {
  BOXD_SPIKE: DurableObjectNamespace<BoxdSpike>;
  BOXD_API_KEY: string;
  BOXD_PROBE_TOKEN: string;
  BOXD_PROBE_OWNER: string;
  BOXD_PROBE_ORG: string;
  BOXD_PROBE_IMAGE: string;
  BOXD_PROBE_LIFETIME_SECONDS: string;
  BOXD_PROBE_EGRESS: string;
}

const decodeEgress = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const settings = (env: Env) => {
  if (!/^sb-boxd-spike-[a-z0-9]{8,20}$/.test(env.BOXD_PROBE_OWNER))
    throw new Error("Invalid probe owner.");
  const seconds = Number(env.BOXD_PROBE_LIFETIME_SECONDS);
  if (!Number.isInteger(seconds) || seconds < 300 || seconds > 3600)
    throw new Error("Invalid probe lifetime.");
  const egressAllow = decodeEgress(env.BOXD_PROBE_EGRESS);
  if (egressAllow.length === 0) throw new Error("Probe egress must be restricted.");
  return {
    owner: env.BOXD_PROBE_OWNER,
    lifetimeMs: seconds * 1000,
    org: env.BOXD_PROBE_ORG,
    image: env.BOXD_PROBE_IMAGE,
    egressAllow,
  };
};

export class BoxdSpike extends DurableObject<Env> {
  private readonly tokens: TokenCache;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.tokens = new TokenCache(
      {
        get: (key) => ctx.storage.get(key),
        put: (key, value) => ctx.storage.put(key, value),
      },
      () => exchangeToken(env.BOXD_API_KEY),
      () => Date.now(),
    );
  }

  /** Binding-only RPC. The HTTP worker never forwards paths to this object. */
  session() {
    return this.tokens.get();
  }

  async read() {
    const saved = await this.ctx.storage.get("probe");
    return saved === undefined ? null : Probe.decodeRecord(saved);
  }

  async status() {
    return {
      run: await this.read(),
      worker:
        (await this.ctx.storage.get<{ connected: true; durationMs: number }>("worker-connect")) ??
        null,
    };
  }

  async workerConnected(durationMs: number) {
    await this.ctx.storage.put("worker-connect", { connected: true, durationMs });
  }

  private exclusive<A>(run: () => Promise<A>): Promise<A> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  advance(archive = false) {
    return this.exclusive(() => this.run(archive ? "archive" : "advance"));
  }

  private async run(action: "advance" | "archive" | "sweep") {
    const config = settings(this.env);
    const client = sdkClient(await this.tokens.get());
    const dependencies = Layer.merge(
      Layer.succeed(Probe.ProbeStore, {
        load: () => this.ctx.storage.get("probe"),
        save: async (record) => {
          // Arm cleanup before a provider call can allocate anything.
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
          await this.ctx.storage.put("probe", record);
        },
        now: () => Date.now(),
      }),
      Layer.succeed(Probe.ProbeApi, makeSdkApi(client, config)),
    );
    try {
      return await Effect.runPromise(
        Effect.gen(function* () {
          const probe = yield* Probe.Probe;
          return yield* action === "sweep" ? probe.sweep : probe.advance(action === "archive");
        }).pipe(Effect.provide(Probe.layer(config).pipe(Layer.provide(dependencies)))),
      );
    } finally {
      await client.close();
    }
  }

  override alarm() {
    return this.exclusive(async () => {
      const record = await this.read();
      if (!record) return;
      // Watch for late create/fork completions past the run deadline plus provider TTL.
      if (Date.now() > record.deadline + 3_600_000 && record.done) return;
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      try {
        await this.run("sweep");
      } catch {
        /* The next alarm retries without logging credentials. */
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const probe = env.BOXD_SPIKE.getByName("singleton");
    return handleProbe(request, env.BOXD_PROBE_TOKEN, {
      status: () => probe.status(),
      advance: (archive) => probe.advance(archive),
      workerConnect: async () => {
        // This call originates in the Worker, separately from the DO's connect step.
        const client = sdkClient(await probe.session());
        try {
          const startedAt = Date.now();
          await client.machines.list({ org: env.BOXD_PROBE_ORG });
          const durationMs = Date.now() - startedAt;
          await probe.workerConnected(durationMs);
          return { connected: true, durationMs };
        } finally {
          await client.close();
        }
      },
    });
  },
} satisfies ExportedHandler<Env>;
