// @effect-diagnostics globalTimers:off - pauses let the harness sample this isolate between setup steps.
import { DurableObject } from "cloudflare:workers";
import type { AssetFetcher } from "../../../../src/assets/ChunkedAsset.ts";
import type { HarnessProcessResumePreparedRelease } from "../../../../src/harness/HarnessProcessResume.ts";
import { readClaudeFacetConfiguration } from "./claudeFacetConfiguration.ts";
import {
  loadClaudeQualificationRelease,
  readClaudeQualificationInputs,
} from "./claudeConfiguration.ts";

type Env = Parameters<typeof readClaudeFacetConfiguration>[0] & {
  readonly PROGRAM_ASSETS: AssetFetcher;
  readonly SELECTED_ARTIFACT: HarnessProcessResumePreparedRelease["artifact"];
  readonly PROBE: DurableObjectNamespace<ClaudeFacetSetupProbe>;
};

/** Runs the Claude facet's setup reads as its retained path does: configuration twice, then the release. */
export class ClaudeFacetSetupProbe extends DurableObject<Env> {
  readonly #held: unknown[] = [];

  ready() {
    return true;
  }

  async setup() {
    const cap = { hostConfiguration: async () => ({ runId: this.env.RUN_ID }) };
    // The harness samples the heap while each step's garbage is still uncollected.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
    const first = await readClaudeFacetConfiguration(this.env, cap as never);
    await pause();
    const second = await readClaudeFacetConfiguration(this.env, cap as never);
    await pause();
    const inputs = await readClaudeQualificationInputs(second.claude, this.env.PROGRAM_ASSETS);
    const release = await loadClaudeQualificationRelease(inputs, this.env.SELECTED_ARTIFACT);
    await pause();
    this.#held.push(first, second, inputs, release);
    // The harness runs this isolate with --expose-gc.
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    gc?.();
    return {
      collected: gc !== undefined,
      releaseLoaded: Object.keys(release.plan.preparedModules).length > 0,
    };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const probe = env.PROBE.getByName("probe");
    if (new URL(request.url).pathname === "/ready") return Response.json(await probe.ready());
    return Response.json(await probe.setup());
  },
};
