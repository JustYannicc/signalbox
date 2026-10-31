import {
  collectClaudeQualificationWorkload,
  type CollectClaudeQualificationWorkloadInput,
} from "./claudeCollector.ts";
import {
  collectClaudeModelWorkloadEvidence,
  type ClaudePersistedModelRecord,
} from "./fixture/claudeModelEvidence.ts";
import type { ClaudeWorkflowObservation } from "./fixture/claudeWorkflowContracts.ts";
import { claudeLane } from "./fixture/claudeCTransport.ts";
import type { ClaudeMcpProbe } from "./fixture/claudeMcpProbe.ts";
import type { HarnessRunArtifact } from "../../../src/harness/HarnessRunStore.ts";
import type { Lifecycle } from "./fixture/lifecycle.ts";
import { classifyV8Termination, type V8TerminationEvidence } from "./termination.ts";
import { samePreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { sameData } from "../../../src/harness/HarnessProcessResume.ts";

interface ClaudeInputs {
  readonly workload: CollectClaudeQualificationWorkloadInput;
  readonly workflow: ClaudeWorkflowObservation;
  readonly modelRecords: readonly ClaudePersistedModelRecord[];
}

/** Joins three completed public requests, their one replacement, retained model bytes and final joins. */
export async function collectCombinedQualification(input: {
  readonly runId: string;
  readonly classification: "synthetic" | "official";
  readonly collectorNonce: string;
  readonly model: string;
  readonly mcpProbe: ClaudeMcpProbe;
  readonly codex: Awaited<ReturnType<Lifecycle["finish"]>>;
  readonly claude: Readonly<Record<"baseline" | "hooks", ClaudeInputs>>;
  readonly readArtifact: (reference: HarnessRunArtifact) => Promise<Uint8Array>;
  readonly termination?: V8TerminationEvidence;
}) {
  const codex = input.codex;
  if (
    !input.runId ||
    codex.completedTurns !== 3 ||
    codex.replacementCount !== 1 ||
    codex.model.complete.completedTurns !== 3 ||
    codex.model.complete.replacements !== 1 ||
    codex.model.complete.nativeSessionId !== codex.nativeSessionId ||
    codex.ownership.writer !== null ||
    codex.ownership.leases !== 0 ||
    codex.evidence.terminal.length !== 3 ||
    codex.evidence.terminal.some(
      ({ value }) =>
        value.nativeSessionId !== codex.nativeSessionId ||
        !value.stopped ||
        !value.joined.invocationRpc ||
        !value.joined.fetch ||
        !value.joined.ports,
    )
  )
    throw new Error("DEPLOY3_COMBINED_CODEX_COMPLETION_INVALID");
  const collect = async (variant: "baseline" | "hooks") => {
    const supplied = input.claude[variant];
    const lane = claudeLane(input.runId, variant);
    const workflow = supplied.workflow;
    const work = workflow.turns.find((turn) => turn.phase === "work");
    const resume = workflow.turns.find((turn) => turn.phase === "resume");
    const finish = workflow.turns.find((turn) => turn.phase === "finish");
    const replacement = workflow.replacement;
    const completion = workflow.completion;
    const firstIdentity = work?.shard.processes[0]?.identity;
    const resumedIdentity = resume?.shard.processes[0]?.identity;
    const finalIdentity = finish?.shard.processes[0]?.identity;
    if (
      workflow.variant !== variant ||
      !sameData(workflow.lane, lane) ||
      workflow.firstPublicCall !== "startFreshProcess" ||
      workflow.turns.length !== 3 ||
      !work ||
      !resume ||
      !finish ||
      new Set(workflow.turns.map((turn) => turn.requestId)).size !== 3 ||
      workflow.turns.some((turn) => turn.terminal.nativeSessionId !== completion.nativeSessionId) ||
      completion.creation.nativeSessionId !== completion.nativeSessionId ||
      completion.completedTurns !== 3 ||
      completion.replacementCount !== 1 ||
      completion.ownership.writer !== null ||
      completion.ownership.leases !== 0 ||
      !firstIdentity ||
      !resumedIdentity ||
      !finalIdentity ||
      firstIdentity.incarnationNonce === resumedIdentity.incarnationNonce ||
      firstIdentity.loaderId === resumedIdentity.loaderId ||
      !sameData(resumedIdentity, replacement.resumed.identity) ||
      !sameData(resumedIdentity, finalIdentity) ||
      !replacement.oldControllerDenied ||
      replacement.oldRelease.sequence >= replacement.publication.sequence ||
      completion.evidence.terminal.length === 0 ||
      completion.evidence.terminal.some(
        ({ value }) =>
          value.nativeSessionId !== completion.nativeSessionId ||
          !value.stopped ||
          !value.joined.invocationRpc ||
          !value.joined.fetch ||
          !value.joined.ports,
      )
    )
      throw new Error("DEPLOY3_COMBINED_CLAUDE_WORKFLOW_IDENTITY_INVALID");
    for (const turn of workflow.turns) {
      const entries = turn.runStore.snapshot.requests?.entries.filter(
        (entry) => entry.request.requestId === turn.requestId,
      );
      const entry = entries?.[0];
      const process = turn.shard.processes[0];
      if (
        turn.runStore.snapshot.seed.identity.runId !== lane.runId ||
        entries?.length !== 1 ||
        entry?.status !== "completed" ||
        entry.finish?.status !== "completed" ||
        !samePreparedRelease(
          turn.loadedPreparedRelease,
          supplied.workload.expectedPreparedRelease,
        ) ||
        turn.terminal.status !== "completed" ||
        turn.terminal.requestId !== turn.requestId ||
        turn.files.checkpointId !== entry.finish.checkpoint.filesystem.id ||
        turn.shard.processes.length !== 1 ||
        process?.processId !== lane.processId ||
        (process.status !== "idle" && process.status !== "settled") ||
        typeof turn.commit !== "object" ||
        turn.commit === null ||
        Reflect.get(turn.commit, "status") !== "committed"
      )
        throw new Error("DEPLOY3_COMBINED_CLAUDE_PUBLIC_RECEIPT_INVALID");
    }
    if (
      supplied.workload.runId !== input.runId ||
      supplied.workload.scenario !== variant ||
      supplied.workload.classification !== input.classification ||
      supplied.workload.requestId !== work.requestId
    )
      throw new Error("DEPLOY3_COMBINED_CLAUDE_OBSERVER_OWNER_MISMATCH");
    const workload = collectClaudeQualificationWorkload(supplied.workload);
    const model = await collectClaudeModelWorkloadEvidence({
      records: supplied.modelRecords,
      readArtifact: input.readArtifact,
      collectorNonce: input.collectorNonce,
      model: input.model,
      mcpProbe: input.mcpProbe,
      publicBinding: {
        runId: lane.runId,
        variant,
        requests: {
          work: work.requestId,
          resume: resume.requestId,
          finish: finish.requestId,
        },
      },
    });
    return {
      variant,
      workload,
      workflow,
      model,
      criteria: workload.criteria.map((criterion) => ({
        name: criterion.name,
        status: "observed" as const,
        detail:
          "Public C creation, three completed requests, one replacement, final joins, retained model wire results and the nonce observer belong to this workload.",
      })),
    };
  };
  const [baseline, hooks] = await Promise.all([collect("baseline"), collect("hooks")]);
  const termination = input.termination
    ? classifyV8Termination(input.termination)
    : "NO_VERIFIED_TERMINATION";
  return {
    schema: "signalbox/deploy3-combined-qualification-result/v1",
    runId: input.runId,
    classification: input.classification,
    status: "observed",
    apiRevision: "EC1APIr2",
    codex,
    claude: { baseline, hooks },
    termination,
    qualification: "pending",
    deploymentReady: false,
    blockers: [
      ...(input.classification === "synthetic"
        ? ["Synthetic inputs cannot qualify an official release."]
        : []),
      "Deployed workload completion and unchanged module-init nonce are required for platform policy compliance evidence.",
    ],
  } as const;
}
