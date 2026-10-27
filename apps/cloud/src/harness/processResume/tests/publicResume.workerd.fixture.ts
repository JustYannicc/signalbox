import { HarnessProcessExecutionEntrypoint } from "../../HarnessProcessExecutionEntrypoint.ts";
import { ProofShard, ProofPlacementStore } from "./publicResumeShard.fixture.ts";
import { ProofFilesStore, ProofRunStore, ProofSupervisor } from "./publicResumeStores.fixture.ts";
import { publicResumeProof } from "./publicResumeProof.fixture.ts";
import { publicIdleFailure } from "./publicIdleFailure.fixture.ts";
import { publicIdleProof } from "./publicIdleProof.fixture.ts";
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
export {
  HarnessProcessExecutionEntrypoint,
  ProofShard,
  ProofPlacementStore,
  ProofFilesStore,
  ProofRunStore,
  ProofSupervisor,
};
export default {
  async fetch(request: Request, env: ProofEnv) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/retained-idle/failure-invocation")
        return Response.json(await publicIdleFailure(env, "invocation"));
      if (path === "/retained-idle/failure-checkpoint")
        return Response.json(await publicIdleFailure(env, "checkpoint"));
      if (path === "/retained-idle/stop") return Response.json(await publicIdleProof(env, "stop"));
      if (path === "/retained-idle/reconstruct")
        return Response.json(await publicIdleProof(env, "reconstruct"));
      if (path === "/retained-idle") return Response.json(await publicIdleProof(env));
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
