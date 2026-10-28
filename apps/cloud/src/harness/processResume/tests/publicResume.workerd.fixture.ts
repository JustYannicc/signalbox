import {
  publicEvictionMatrixProof,
  publicEvictionPoints,
  type PublicEvictionPoint,
} from "./publicEvictionMatrixProof.fixture.ts";
import {
  publicResumeAfterEvictionProof,
  publicResumeAfterEvictionCases,
  type PublicResumeAfterEvictionCase,
} from "./publicResumeAfterEviction.fixture.ts";
export { ProofProcessStoreBinding as HarnessProcessStoreBinding } from "./publicResumeStores.fixture.ts";
import { ProofShard, ProofPlacementStore } from "./publicResumeShard.fixture.ts";
import { ProofFilesStore, ProofRunStore, ProofSupervisor } from "./publicResumeStores.fixture.ts";
import { publicResumeProof } from "./publicResumeProof.fixture.ts";
import { publicIdleCycle } from "./publicIdleCycle.fixture.ts";
import { publicIdleFailure } from "./publicIdleFailure.fixture.ts";
import { publicIdleProof } from "./publicIdleProof.fixture.ts";
import { publicWarmDrain } from "./publicWarmDrain.fixture.ts";
import {
  completionFailure,
  resumeFailure,
  cancellationProof,
  heldWorkProof,
  cachedAuthorityProof,
  publicationCancellationProof,
  invocationFailureProof,
} from "./publicResumeFailure.fixture.ts";
import type { ProofEnv } from "./publicResumeSetup.fixture.ts";
export { ProofShard, ProofPlacementStore, ProofFilesStore, ProofRunStore, ProofSupervisor };
export default {
  async fetch(request: Request, env: ProofEnv) {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/eviction/")) {
        const point = path.slice("/eviction/".length) as PublicEvictionPoint;
        if (!publicEvictionPoints.includes(point))
          return new Response("Unknown eviction point", { status: 404 });
        return Response.json(await publicEvictionMatrixProof(env, point));
      }
      if (path.startsWith("/eviction-resume/")) {
        const scenario = path.slice("/eviction-resume/".length) as PublicResumeAfterEvictionCase;
        if (!publicResumeAfterEvictionCases.includes(scenario))
          return new Response("Unknown eviction-resume scenario", { status: 404 });
        return Response.json(await publicResumeAfterEvictionProof(env, scenario));
      }
      if (path === "/warm-drain") return Response.json(await publicWarmDrain(env));
      if (path === "/retained-idle/cycle") return Response.json(await publicIdleCycle(env));
      if (path === "/retained-idle/failure-invocation")
        return Response.json(await publicIdleFailure(env, "invocation"));
      if (path === "/retained-idle/failure-checkpoint")
        return Response.json(await publicIdleFailure(env, "checkpoint"));
      if (path === "/retained-idle/stop") return Response.json(await publicIdleProof(env, "stop"));
      if (path === "/retained-idle/reconstruct")
        return Response.json(await publicIdleProof(env, "reconstruct"));
      if (path === "/retained-idle") return Response.json(await publicIdleProof(env));
      if (path === "/reconstructed-shard")
        return Response.json(await publicResumeProof(env, true, false, { reconstructShard: true }));
      const result =
        path === "/invocation/reject"
          ? await invocationFailureProof(env, "reject")
          : path === "/invocation/failed-finish"
            ? await invocationFailureProof(env, "failed-finish")
            : path.startsWith("/completion/")
              ? await completionFailure(env, path.slice("/completion/".length))
              : path.startsWith("/resume/")
                ? await resumeFailure(env, path.slice("/resume/".length))
                : path === "/cached-authority"
                  ? await cachedAuthorityProof(env)
                  : path === "/publication-cancellation"
                    ? await publicationCancellationProof(env)
                    : path === "/cancellation"
                      ? await cancellationProof(env)
                      : path === "/held-work"
                        ? await heldWorkProof(env)
                        : path === "/transport-without-typed-bindings"
                          ? await publicResumeProof(env, true, false, {
                              omitInitialBootstrap: true,
                            })
                          : path === "/mismatched-observation"
                            ? await publicResumeProof(env, true, true)
                            : await publicResumeProof(env, path === "/positive");
      return Response.json(result);
    } catch (error) {
      return new Response(error instanceof Error ? error.stack : "Public resume proof failed", {
        status: 500,
      });
    }
  },
};
export * from "../../../FixtureWorkerExports.ts";
