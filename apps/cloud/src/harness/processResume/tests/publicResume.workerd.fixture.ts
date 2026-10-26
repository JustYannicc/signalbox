import { HarnessProcessExecutionEntrypoint } from "../../HarnessProcessExecutionEntrypoint.ts";
import { ProofShard, ProofPlacementStore } from "./publicResumeShard.fixture.ts";
import { ProofFilesStore, ProofRunStore, ProofSupervisor } from "./publicResumeStores.fixture.ts";
import { publicResumeProof } from "./publicResumeProof.fixture.ts";
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
