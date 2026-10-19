import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { ProbeSession } from "./worker.ts";
import { prepare } from "./prepare.ts";
import { readChildProgramWasmInventory } from "./programWasmRegistryGeneration.ts";

const programWasmInventory = await readChildProgramWasmInventory(
  process.env.ISOLATE_PROBE_PROGRAM_WASM_INVENTORY,
);
await prepare({ programWasmArtifacts: programWasmInventory.artifacts });

export default Alchemy.Stack(
  "SignalboxIsolateProbe",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (!/^isolate-probe-(?:pr-\d+|[a-f0-9]{8,20})$/.test(stage)) {
      throw new Error("Use an isolated isolate-probe-pr-N or isolate-probe-<hex> stage.");
    }
    const worker = yield* Cloudflare.Worker("Probe", {
      name: `sb-${stage}`,
      main: `${import.meta.dirname}/generated/worker.js`,
      bundle: false,
      compatibility: { date: "2026-10-18", flags: ["nodejs_compat"] },
      workersDev: { enabled: true, previewsEnabled: false },
      limits: { cpuMs: 30_000 },
      observability: { enabled: true },
      env: {
        PROBE: Cloudflare.DurableObject<ProbeSession>("ProbeSession"),
        LOADER: Cloudflare.WorkerLoader(),
        PROBE_SECRET: yield* Config.Redacted("PROBE_SECRET"),
      },
    });
    if (!worker.url) throw new Error("The probe Worker has no URL.");
    return { worker: worker.workerName, url: worker.url };
  }),
);
