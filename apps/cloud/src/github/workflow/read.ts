import type { GitHubApi } from "../GitHubApi.ts";
import * as Effect from "effect/Effect";

import {
  failed,
  normalizeWorkflowFile,
  normalizedSha,
  toWorkflowRun,
  validRunId,
  validSha,
  validateRepository,
} from "./common.ts";
import { makeWorkflowRest } from "./rest.ts";
import type { WorkflowReadInput } from "./types.ts";

export const makeWorkflowRead = (api: GitHubApi) => {
  const rest = makeWorkflowRest(api);

  const readActualRun = (
    token: string,
    repository: string,
    input: { readonly workflowFile: string; readonly headSha: string; readonly runId: string },
    correlationId?: string,
  ) =>
    rest.readRun(token, repository, input.runId).pipe(
      Effect.map((body) =>
        body === null
          ? null
          : toWorkflowRun(body, {
              workflowFile: input.workflowFile,
              headSha: input.headSha,
              ...(correlationId === undefined ? {} : { correlationId }),
            }),
      ),
    );

  const workflowRead = (token: string, repository: string, input: WorkflowReadInput) =>
    Effect.gen(function* () {
      const workflowFile = normalizeWorkflowFile(input.workflowFile);
      if (workflowFile === null) return yield* failed("Pass a safe GitHub workflow file name.");
      if (!validSha(input.headSha))
        return yield* failed("Pass the full 40-character workflow head SHA.");
      if (!validRunId(input.runId)) return yield* failed("Pass a numeric GitHub Actions run ID.");
      if (!validateRepository(repository))
        return yield* failed("The folder's GitHub repository name is invalid.");
      const body = yield* rest.readRun(token, repository, input.runId);
      if (body === null) return null;
      const run = toWorkflowRun(body, {
        workflowFile,
        headSha: normalizedSha(input.headSha),
      });
      if (run === null)
        return yield* failed("The GitHub Actions run doesn't match this workflow and head SHA.");
      return run;
    });

  return { readActualRun, workflowRead };
};
