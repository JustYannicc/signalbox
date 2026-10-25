import { AutomationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HARNESS_RELEASE_RESULT_PATH,
  HARNESS_RELEASE_WORKFLOW_FILE,
  isVerifiedHarnessRelease,
  releaseArtifactName,
  type HarnessReleaseProvider,
} from "@signalbox/automations/defaults/harnessReleasePolicy";

import {
  GitHubActions,
  type WorkflowArtifactInput,
  type WorkflowArtifactResult,
  type WorkflowRun,
} from "../github/GitHubActions.ts";
import {
  createHarnessReleaseLedger,
  type HarnessProvider,
  type HarnessReleaseSelection,
} from "./HarnessReleaseLedger.ts";
import { createHarnessProjectReleaseSqliteStore } from "./HarnessProjectReleaseSqliteStore.ts";
import type { HarnessReleaseSqliteDatabase } from "./HarnessReleaseSqliteStore.ts";

type RecordValue = Record<string, unknown>;
type ProofStatus = "green" | "red" | "pending";
export type HarnessReleaseRunSelection = "current" | "backfill";

export interface HarnessReleaseRecordInput {
  readonly provider: HarnessProvider;
  readonly version: string;
  readonly selection: HarnessReleaseRunSelection;
  readonly runKey: string;
  readonly headSha: string;
  readonly workflowFile: typeof HARNESS_RELEASE_WORKFLOW_FILE;
  readonly workflowRunId: string;
  readonly artifactName: string;
  readonly entryPath: typeof HARNESS_RELEASE_RESULT_PATH;
}

export interface HarnessReleasePromotionInput {
  readonly provider: HarnessProvider;
  readonly releaseId: string;
  readonly expectedRevision: number;
  readonly changedAt: string;
}

export type HarnessReleaseRecordResult =
  | {
      readonly status: "pending";
      readonly proofStatus: "pending";
      readonly proofArtifactVerified: false;
      readonly runtimeArtifactVerified: false;
      readonly reason: string;
    }
  | {
      readonly status: "pending";
      readonly proofStatus: ProofStatus;
      readonly proofArtifactVerified: true;
      readonly runtimeArtifactVerified: false;
      readonly result: RecordValue;
      readonly run: WorkflowRun;
      readonly artifact: WorkflowArtifactResult["artifact"];
      readonly reason: string;
    };

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const proofStatus = (value: unknown): ProofStatus | null =>
  value === "green" || value === "red" || value === "pending" ? value : null;
const decodeArtifactText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isAutomationError = Schema.is(AutomationError);

const pending = (reason: string): HarnessReleaseRecordResult => ({
  status: "pending",
  proofStatus: "pending",
  proofArtifactVerified: false,
  runtimeArtifactVerified: false,
  reason,
});

const ledgerForProject = (storage: HarnessReleaseSqliteDatabase, projectId: string) =>
  projectId.trim() === ""
    ? Effect.fail(new AutomationError({ message: "A project ID is required." }))
    : Effect.try({
        try: () =>
          createHarnessReleaseLedger(createHarnessProjectReleaseSqliteStore(storage, projectId)),
        catch: (cause) =>
          new AutomationError({ message: "Harness release ledger call failed.", cause }),
      });

const makeService = (
  storage: HarnessReleaseSqliteDatabase,
  github: GitHubActions["Service"],
): HarnessReleaseLedgerServiceShape => ({
  selection: (projectId, provider) =>
    ledgerForProject(storage, projectId).pipe(
      Effect.flatMap((ledger) =>
        Effect.try({
          try: () => ledger.getSelection(provider),
          catch: (cause) =>
            new AutomationError({ message: "Harness release selection could not be read.", cause }),
        }),
      ),
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : new AutomationError({ message: "Harness release ledger call failed.", cause }),
      ),
    ),
  record: (projectId, input) =>
    Effect.gen(function* () {
      yield* ledgerForProject(storage, projectId);
      const workflowProvider: HarnessReleaseProvider =
        input.provider === "agent-sdk" ? "claude-agent-sdk" : input.provider;
      if (
        input.workflowFile !== HARNESS_RELEASE_WORKFLOW_FILE ||
        input.entryPath !== HARNESS_RELEASE_RESULT_PATH ||
        input.runKey !== `harness-release:${workflowProvider}:${input.version}` ||
        input.artifactName !==
          releaseArtifactName(workflowProvider, input.version, input.workflowRunId)
      )
        return pending("The request does not name the exact harness proof attempt.");

      const locator: WorkflowArtifactInput = {
        workflowFile: input.workflowFile,
        runId: input.workflowRunId,
        headSha: input.headSha,
        artifactName: input.artifactName,
        entryPath: input.entryPath,
      };
      const artifact = yield* github.workflowArtifact(projectId, locator);
      if (artifact === null)
        return pending("The completed workflow artifact is not available yet.");

      const decoded = yield* decodeArtifactText(artifact.text).pipe(
        Effect.mapError(
          (cause) =>
            new AutomationError({
              message: `The verified artifact ${HARNESS_RELEASE_RESULT_PATH} is invalid.`,
              cause,
            }),
        ),
      );
      const result = isRecord(decoded) ? decoded : null;
      if (result === null) return pending("The verified artifact result is not an object.");

      const status = proofStatus(result.status);
      if (status === null)
        return pending("The workflow artifact identity does not match this release attempt.");
      const exact =
        result.schemaVersion === 1 &&
        result.provider === workflowProvider &&
        result.version === input.version &&
        result.runKey === input.runKey &&
        result.selection === input.selection &&
        isRecord(result.source) &&
        result.source.commit === input.headSha &&
        artifact.run.runId === input.workflowRunId &&
        artifact.run.workflowFile === HARNESS_RELEASE_WORKFLOW_FILE &&
        artifact.run.headSha === input.headSha &&
        artifact.run.displayTitle === input.runKey &&
        artifact.run.status === "completed" &&
        artifact.artifact.name === input.artifactName &&
        artifact.artifact.entryPath === HARNESS_RELEASE_RESULT_PATH &&
        typeof artifact.artifact.id === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(artifact.artifact.digest) &&
        /^[a-f0-9]{64}$/u.test(artifact.artifact.sha256) &&
        Number.isSafeInteger(artifact.artifact.bytes) &&
        artifact.artifact.bytes > 0 &&
        (status === "green"
          ? artifact.run.conclusion === "success"
          : artifact.run.conclusion === "failure");
      if (!exact)
        return pending("The workflow artifact identity does not match this release attempt.");

      const verifiedStatus =
        status === "green" &&
        !isVerifiedHarnessRelease("green", result as Parameters<typeof isVerifiedHarnessRelease>[1])
          ? "pending"
          : status;
      const reason =
        verifiedStatus === "pending"
          ? "The immutable artifact is valid, but its public proof criteria are incomplete."
          : "The immutable proof is verified, but its deployable runtime payload is not available yet.";

      return {
        status: "pending" as const,
        proofStatus: verifiedStatus,
        proofArtifactVerified: true as const,
        runtimeArtifactVerified: false as const,
        result,
        run: artifact.run,
        artifact: artifact.artifact,
        reason,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : new AutomationError({ message: "Harness release ledger call failed.", cause }),
      ),
    ),
  promote: (projectId) =>
    ledgerForProject(storage, projectId).pipe(
      Effect.as(pending("A deployable runtime payload has not been published and verified.")),
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : new AutomationError({ message: "Harness release ledger call failed.", cause }),
      ),
    ),
});

export interface HarnessReleaseLedgerServiceShape {
  readonly selection: (
    projectId: string,
    provider: HarnessProvider,
  ) => Effect.Effect<HarnessReleaseSelection, AutomationError>;
  readonly record: (
    projectId: string,
    input: HarnessReleaseRecordInput,
  ) => Effect.Effect<HarnessReleaseRecordResult, AutomationError>;
  readonly promote: (
    projectId: string,
    input: HarnessReleasePromotionInput,
  ) => Effect.Effect<HarnessReleaseRecordResult, AutomationError>;
}

export class HarnessReleaseLedgerService extends Context.Service<
  HarnessReleaseLedgerService,
  HarnessReleaseLedgerServiceShape
>()("@signalbox/cloud/harnessReleases/HarnessReleaseLedgerService") {}

/** `projectId` comes from the automation run, never from its editable input. */
export const harnessReleaseLedgerLayer = (storage: HarnessReleaseSqliteDatabase) =>
  Layer.effect(
    HarnessReleaseLedgerService,
    Effect.gen(function* () {
      const github = yield* GitHubActions;
      return HarnessReleaseLedgerService.of(makeService(storage, github));
    }),
  );
