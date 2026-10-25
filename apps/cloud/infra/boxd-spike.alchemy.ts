import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { BoxdSpike } from "../src/boxdSpike/worker.ts";

/** Separate stack, never imported by the product stack or its deploy workflow. */
export default Alchemy.Stack(
  "SignalboxBoxdSpike",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (!/^boxd-spike-[a-z0-9]{8,20}$/.test(stage))
      throw new Error("Use a unique boxd-spike-<id> stage.");
    const worker = yield* Cloudflare.Worker("Probe", {
      name: `sb-${stage}`,
      main: `${import.meta.dirname}/../src/boxdSpike/worker.ts`,
      compatibility: { date: "2026-06-04", flags: ["nodejs_compat", "legacy_module_registry"] },
      workersDev: true,
      // SDK errors may include upstream payloads. Only /status carries safe evidence.
      observability: { enabled: false },
      limits: { cpuMs: 30_000 },
      env: {
        BOXD_SPIKE: Cloudflare.DurableObject<BoxdSpike>("BoxdSpike"),
        BOXD_API_KEY: yield* Config.Redacted("BOXD_API_KEY"),
        BOXD_PROBE_TOKEN: yield* Config.Redacted("BOXD_PROBE_TOKEN"),
        BOXD_PROBE_OWNER: `sb-${stage}`,
        BOXD_PROBE_ORG: yield* Config.String("BOXD_PROBE_ORG").pipe(Config.withDefault("")),
        BOXD_PROBE_IMAGE: yield* Config.String("BOXD_PROBE_IMAGE").pipe(Config.withDefault("")),
        BOXD_PROBE_LIFETIME_SECONDS: yield* Config.String("BOXD_PROBE_LIFETIME_SECONDS").pipe(
          Config.withDefault("900"),
        ),
        BOXD_PROBE_EGRESS: yield* Config.String("BOXD_PROBE_EGRESS").pipe(
          Config.withDefault('["example.invalid"]'),
        ),
      },
    });
    return { worker: worker.workerName, url: worker.url };
  }),
);
