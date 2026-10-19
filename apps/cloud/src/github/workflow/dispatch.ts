import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type GitHubApi } from "../GitHubApi.ts";
import { type GitHubOperationJournal, type WorkflowAttemptKey } from "../githubOperationJournal.ts";
import {
  decodeJson,
  containsControlCharacters,
  failed,
  knownRejection,
  normalizeWorkflowFile,
  normalizedSha,
  pendingDispatch,
  toWorkflowRun,
  validCorrelationId,
  validRunId,
  validSha,
  validateRepository,
  workflowName,
} from "./common.ts";
import { DispatchBody, type WorkflowRunBody, makeWorkflowRest } from "./rest.ts";
import { makeWorkflowRead } from "./read.ts";
import type { WorkflowDispatchInput, WorkflowRun } from "./types.ts";

const exactRunMatches = (
  body: WorkflowRunBody,
  input: {
    readonly workflowFile: string;
    readonly headSha: string;
    readonly correlationId: string;
  },
) => toWorkflowRun(body, input) !== null;

export const makeWorkflowDispatch = (api: GitHubApi, journal: GitHubOperationJournal) => {
  const rest = makeWorkflowRest(api);
  const { readActualRun, workflowRead } = makeWorkflowRead(api);

  const dispatchKey = (
    projectId: string,
    repository: string,
    input: WorkflowDispatchInput,
    workflowFile: string,
    headSha: string,
  ): WorkflowAttemptKey => ({
    projectId,
    repository,
    workflowFile,
    correlationId: input.correlationId,
    headSha,
  });

  const matchingRuns = (
    token: string,
    repository: string,
    input: {
      readonly workflowFile: string;
      readonly headSha: string;
      readonly correlationId: string;
    },
  ) =>
    rest.workflowRuns(token, repository, workflowName(input.workflowFile), input.headSha).pipe(
      Effect.flatMap(({ runs, capped }) => {
        const matches = runs.filter((run) => exactRunMatches(run, input));
        return capped && matches.length === 0
          ? Effect.fail(
              failed(
                "GitHub's workflow run search reached its 1,000-result limit; Signalbox can't confirm whether this correlation ID already ran.",
              ),
            )
          : Effect.succeed(matches);
      }),
    );

  const acceptExistingRun = (
    token: string,
    repository: string,
    input: {
      readonly workflowFile: string;
      readonly headSha: string;
      readonly correlationId: string;
    },
    candidate: WorkflowRunBody,
  ) =>
    readActualRun(
      token,
      repository,
      { ...input, runId: String(candidate.id) },
      input.correlationId,
    ).pipe(
      Effect.flatMap((run) =>
        run === null
          ? Effect.fail(failed("The matching workflow run no longer matches its dispatch request."))
          : Effect.succeed(run),
      ),
    );

  const findRun = (
    token: string,
    repository: string,
    input: {
      readonly workflowFile: string;
      readonly headSha: string;
      readonly correlationId: string;
    },
  ) =>
    matchingRuns(token, repository, input).pipe(
      Effect.flatMap((runs) => {
        if (runs.length > 1)
          return Effect.fail(
            failed("More than one GitHub Actions run matches this correlation ID."),
          );
        const candidate = runs[0];
        return candidate === undefined
          ? Effect.succeed(null)
          : acceptExistingRun(token, repository, input, candidate);
      }),
    );

  const finishWorkflow = (key: WorkflowAttemptKey, requestHash: string, run: WorkflowRun) =>
    journal.completeWorkflow({ ...key, requestHash, result: run }).pipe(Effect.as(run));

  const completeWorkflowAttempt = (
    token: string,
    repository: string,
    key: WorkflowAttemptKey,
    requestHash: string,
  ) =>
    findRun(token, repository, key).pipe(
      Effect.flatMap((run) =>
        run === null ? Effect.fail(pendingDispatch()) : finishWorkflow(key, requestHash, run),
      ),
    );

  const recoverUncertainDispatch = (
    token: string,
    repository: string,
    key: WorkflowAttemptKey,
    requestHash: string,
    originalError: AutomationError,
    expectedRunId?: string,
  ) =>
    Effect.result(findRun(token, repository, key)).pipe(
      Effect.flatMap((readback) =>
        readback._tag === "Failure"
          ? Effect.fail(
              failed(
                "The dispatch outcome is unknown and GitHub readback failed; the durable attempt stays pending.",
                readback.failure,
              ),
            )
          : readback.success === null
            ? Effect.fail(pendingDispatch(originalError))
            : expectedRunId !== undefined && readback.success.runId !== expectedRunId
              ? Effect.fail(
                  failed(
                    "GitHub's returned run ID doesn't match the exact correlation and head SHA.",
                    originalError,
                  ),
                )
              : finishWorkflow(key, requestHash, readback.success),
      ),
    );

  const workflowDispatch = (
    token: string,
    repository: string,
    projectId: string,
    input: WorkflowDispatchInput,
  ) =>
    Effect.gen(function* () {
      if (!validateRepository(repository))
        return yield* failed("The folder's GitHub repository name is invalid.");
      const workflowFile = normalizeWorkflowFile(input.workflowFile);
      if (workflowFile === null) return yield* failed("Pass a safe GitHub workflow file name.");
      if (!validSha(input.headSha))
        return yield* failed("Pass the full 40-character workflow head SHA.");
      if (!validCorrelationId(input.correlationId))
        return yield* failed("Pass a non-empty correlation ID of at most 256 characters.");
      if (
        input.inputs === null ||
        typeof input.inputs !== "object" ||
        Array.isArray(input.inputs) ||
        Object.values(input.inputs).some((value) => typeof value !== "string") ||
        ![input.inputs.runKey, input.inputs.correlationId].some(
          (value) => value === input.correlationId,
        ) ||
        [input.inputs.runKey, input.inputs.correlationId].some(
          (value) => value !== undefined && value !== input.correlationId,
        )
      )
        return yield* failed(
          "Set inputs.runKey or inputs.correlationId to the exact correlationId so the workflow run name can be verified.",
        );
      if (input.ref.length === 0 || containsControlCharacters(input.ref))
        return yield* failed("Pass a valid workflow ref.");

      const headSha = normalizedSha(input.headSha);
      const key = dispatchKey(projectId, repository, input, workflowFile, headSha);
      const request = { ref: input.ref, headSha, inputs: input.inputs };
      const attempt = yield* journal.claimWorkflow({ ...key, request });
      if (attempt._tag === "completed") {
        const saved = decodeJson(
          Schema.Struct({
            runId: Schema.String,
            url: Schema.String,
            workflowFile: Schema.String,
            headSha: Schema.String,
            displayTitle: Schema.String,
            status: Schema.String,
            conclusion: Schema.NullOr(Schema.String),
          }),
          attempt.resultJson,
        );
        if (
          saved === null ||
          saved.workflowFile !== workflowFile ||
          saved.headSha !== headSha ||
          saved.displayTitle !== input.correlationId ||
          !validRunId(saved.runId)
        )
          return yield* failed("The saved workflow result doesn't match its durable attempt.");
        const current = yield* readActualRun(
          token,
          repository,
          { workflowFile, headSha, runId: saved.runId },
          input.correlationId,
        );
        if (current === null) return yield* pendingDispatch();
        return current;
      }
      if (attempt._tag === "pending")
        return yield* completeWorkflowAttempt(token, repository, key, attempt.requestHash);

      const alreadyRunning = yield* matchingRuns(token, repository, key).pipe(
        Effect.catch((error) =>
          journal
            .releaseWorkflow({ ...key, requestHash: attempt.requestHash })
            .pipe(Effect.flatMap(() => Effect.fail(error))),
        ),
      );
      if (alreadyRunning.length > 1)
        return yield* failed("More than one GitHub Actions run matches this correlation ID.");
      const existing = alreadyRunning[0];
      if (existing !== undefined) {
        const accepted = yield* acceptExistingRun(token, repository, key, existing);
        return yield* finishWorkflow(key, attempt.requestHash, accepted);
      }

      const response = yield* Effect.result(
        rest.dispatch(token, repository, workflowName(workflowFile), {
          ref: input.ref,
          inputs: input.inputs,
        }),
      );
      if (response._tag === "Failure") {
        if (knownRejection(response.failure)) {
          yield* journal.releaseWorkflow({ ...key, requestHash: attempt.requestHash });
          return yield* response.failure;
        }
        return yield* recoverUncertainDispatch(
          token,
          repository,
          key,
          attempt.requestHash,
          response.failure,
        );
      }
      if (response.success === null) {
        yield* journal.releaseWorkflow({ ...key, requestHash: attempt.requestHash });
        return yield* failed("GitHub could not find the requested workflow on this repository.");
      }

      const details = decodeJson(DispatchBody, response.success);
      if (
        details === null ||
        !Number.isSafeInteger(details.workflow_run_id) ||
        details.workflow_run_id < 1
      )
        return yield* recoverUncertainDispatch(
          token,
          repository,
          key,
          attempt.requestHash,
          pendingDispatch(),
        );

      const runId = String(details.workflow_run_id);
      const returned = yield* readActualRun(
        token,
        repository,
        { workflowFile, headSha, runId },
        input.correlationId,
      ).pipe(
        Effect.catch((error) =>
          recoverUncertainDispatch(token, repository, key, attempt.requestHash, error, runId),
        ),
      );
      if (returned === null)
        return yield* recoverUncertainDispatch(
          token,
          repository,
          key,
          attempt.requestHash,
          pendingDispatch(),
          runId,
        );
      if (returned.url !== details.html_url)
        return yield* failed(
          "GitHub's dispatch response URL didn't match the returned run.",
          pendingDispatch(),
        );
      return yield* finishWorkflow(key, attempt.requestHash, returned);
    });

  return { workflowDispatch, workflowRead };
};
