import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { COMPUTER_BOXD_PROOF_STAGE, proofOwner } from "./computerBoxdProof/Deployment.ts";
import type { ComputerBoxdProof } from "./computerBoxdProof/worker.ts";

/** Isolated stack for the manually dispatched real boxd computer proof. */
export default Alchemy.Stack(
  "SignalboxComputerBoxdProof",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (!COMPUTER_BOXD_PROOF_STAGE.test(stage)) {
      throw new Error("Use a unique computer-boxd-<id> stage.");
    }

    const owner = yield* Config.String("BOXD_PROOF_OWNER").pipe(
      Config.withDefault(proofOwner(stage)),
    );
    if (owner !== proofOwner(stage))
      throw new Error("BOXD_PROOF_OWNER must match the proof stage.");

    const worker = yield* Cloudflare.Worker("ComputerBoxdProof", {
      name: proofOwner(stage),
      main: yield* Config.String("BOXD_PROOF_WORKER_ENTRY"),
      bundle: false,
      compatibility: {
        date: "2026-06-04",
        flags: ["nodejs_compat", "legacy_module_registry"],
      },
      workersDev: true,
      observability: { enabled: false },
      env: {
        BOXD_PROOF: Cloudflare.DurableObject<ComputerBoxdProof>("ComputerBoxdProof"),
        CHILD_WORKERS: Cloudflare.WorkerLoader(),
        BOXD_API_KEY: yield* Config.Redacted("BOXD_API_KEY"),
        BOXD_PROOF_TOKEN: yield* Config.Redacted("BOXD_PROOF_TOKEN"),
        BOXD_PROOF_OWNER: owner,
      },
    });
    if (!worker.url) throw new Error("The proof Worker has no URL.");
    return { worker: worker.workerName, url: worker.url };
  }),
);
