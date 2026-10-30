import { claudeQualificationColdTimer } from "../claudeWorkload.ts";
import type {
  ColdFirstSuccessfulRpcTimer,
  ColdFirstSuccessfulRpcTiming,
} from "../../../harnessReleases/claudeQualification/contracts.ts";
import type {
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "../../../../src/harness/HarnessProcessPlacement.ts";
import type {
  HarnessProcessCheckpointInput,
  HarnessProcessContinuationInput,
  HarnessProcessResumeOperationInput,
} from "../../../../src/harness/HarnessProcessResume.ts";
import type { HarnessFilesCheckpoint } from "../../../../src/harness/HarnessFilesStore.ts";
import type {
  HarnessRunStoreResult,
  HarnessRunArtifact,
} from "../../../../src/harness/HarnessRunStore.ts";
import { claudeLane, createClaudeCTransport, type ClaudeVariant } from "./claudeCTransport.ts";
import { assert } from "./common.ts";
export { collectClaudeModelWorkloadEvidence } from "./claudeModelEvidence.ts";
export type {
  ClaudePersistedModelRecord,
  ClaudeModelWorkloadEvidence,
} from "./claudeModelEvidence.ts";

type ClaudeCTransport = ReturnType<typeof createClaudeCTransport>;

export type ClaudeWorkflowPhase = "work" | "resume" | "interrupt";

export interface ClaudeWorkflowTurn {
  readonly phase: ClaudeWorkflowPhase;
  readonly requestId: string;
  readonly processId: string;
  readonly nativeSessionId: string;
  readonly runShard?: {
    readonly input: HarnessProcessExecutionShardInput;
    readonly requestContextId: string;
  };
  readonly resumeProcess?: HarnessProcessResumeOperationInput;
  readonly continuation?: {
    readonly input: HarnessProcessContinuationInput;
    readonly requestContextId: string;
  };
}

export interface ClaudeWorkflowPorts {
  /** Each method must enter the public object/command boundary captured by C. */
  readonly c: ClaudeCTransport;
  /** Resolves at the persisted request.finish event; it must not poll or sleep. */
  readonly waitForFinish: (requestId: string) => Promise<void>;
  readonly readRunStore: () => Promise<HarnessRunStoreResult>;
  /** Reads the actual FilesStore checkpoint selected by the public RunStore finish. */
  readonly materializeFiles: (
    requestId: string,
    reference: HarnessRunArtifact,
  ) => Promise<HarnessFilesCheckpoint>;
  /** Builds the typed public C checkpoint command from captured authorities. */
  readonly checkpointInput: (input: {
    readonly turn: ClaudeWorkflowTurn;
    readonly runStore: HarnessRunStoreResult;
    readonly files: HarnessFilesCheckpoint;
  }) => Promise<HarnessProcessCheckpointInput>;
  /** Reads actual public Runner terminal evidence for this request and native session. */
  readonly nativeTerminal: (input: {
    readonly requestId: string;
    readonly nativeSessionId: string;
  }) => Promise<{
    readonly requestId: string;
    readonly nativeSessionId: string;
    readonly status: string;
  }>;
  /** Must be an actual active-turn interruption capability. There is no C substitute here. */
  readonly interruptActiveTurn?: (input: {
    readonly requestId: string;
    readonly nativeSessionId: string;
  }) => Promise<unknown>;
}

export interface ClaudeWorkflowTurnReceipt {
  readonly phase: ClaudeWorkflowPhase;
  readonly requestId: string;
  readonly status: "committed";
  readonly runStore: HarnessRunStoreResult;
  readonly files: HarnessFilesCheckpoint;
  readonly commit: unknown;
  readonly shard: HarnessProcessExecutionShardResult;
  readonly terminal: {
    readonly requestId: string;
    readonly nativeSessionId: string;
    readonly status: string;
  };
}

export interface ClaudeWorkflowObservation {
  readonly schema: "signalbox/claude-qualification-public-c-workflow/v1";
  readonly purpose: "qualification";
  readonly variant: ClaudeVariant;
  readonly lane: ReturnType<typeof claudeLane>;
  readonly status: "observed";
  readonly qualification: "pending";
  readonly firstPublicCall: "runShard";
  readonly coldStartupUpperBound: ColdFirstSuccessfulRpcTiming;
  readonly turns: readonly ClaudeWorkflowTurnReceipt[];
  readonly interruption: { readonly status: "pending"; readonly reason: string };
  readonly criteria: readonly {
    readonly name:
      | "text"
      | "readEdit"
      | "bash"
      | "grep"
      | "resume"
      | "mcp"
      | "interrupt"
      | "publicHarness";
    readonly status: "pending";
    readonly reason: string;
  }[];
}

/** Runs only requests backed by public C inputs, Store events, checkpoint bytes and Runner events. */
export async function runClaudeQualificationWorkflow(input: {
  readonly rootRunId: string;
  readonly variant: ClaudeVariant;
  readonly turns: readonly ClaudeWorkflowTurn[];
  readonly ports: ClaudeWorkflowPorts;
  readonly timer?: ColdFirstSuccessfulRpcTimer;
}): Promise<ClaudeWorkflowObservation> {
  const lane = claudeLane(input.rootRunId, input.variant);
  if (
    input.turns.length !== 3 ||
    input.turns.map((turn) => turn.phase).join(",") !== "work,interrupt,resume"
  )
    throw new Error("CLAUDE_QUALIFICATION_C_WORK_INTERRUPT_RESUME_REQUIRED");
  if (input.turns[0]?.phase !== "work")
    throw new Error("CLAUDE_QUALIFICATION_FIRST_C_TURN_MUST_BE_WORK");
  if (input.turns.some((turn, index) => turn.phase === "resume" && index === 0))
    throw new Error("CLAUDE_QUALIFICATION_RESUME_REQUIRES_PRIOR_CHECKPOINT");
  const needsInterrupt = input.turns.some((turn) => turn.phase === "interrupt");
  if (needsInterrupt && input.ports.interruptActiveTurn === undefined)
    throw new Error("CLAUDE_QUALIFICATION_PUBLIC_INTERRUPT_AUTHORITY_MISSING");

  if (!input.turns[0]?.runShard)
    throw new Error("CLAUDE_QUALIFICATION_FIRST_PUBLIC_CALL_MUST_BE_RUN_SHARD");
  let coldStartupUpperBound: ColdFirstSuccessfulRpcTiming | undefined;
  const receipts: ClaudeWorkflowTurnReceipt[] = [];
  for (const turn of input.turns) {
    assert(turn.requestId.length > 0, "Claude public request ID is missing");
    assert(
      turn.nativeSessionId.length > 0 && turn.nativeSessionId === input.turns[0]!.nativeSessionId,
      "Claude native session identity is missing or changed between workflow phases",
    );
    assert(turn.processId === lane.processId, "Claude process belongs to another public C lane");

    if (turn.phase === "resume") {
      assert(turn.resumeProcess, "Claude resume phase has no public resume operation");
      const resumed = await input.ports.c.resumeProcess(turn.resumeProcess);
      assert(
        resumed.status === "resumed" &&
          resumed.identity.loaderId.length > 0 &&
          resumed.identity.incarnationNonce.length > 0 &&
          resumed.identity.incarnationNonce !==
            receipts.at(-1)?.shard.processes[0]?.identity?.incarnationNonce,
        "Claude public resume changed its native session or process identity",
      );
    }

    if (turn.phase === "interrupt") {
      assert(turn.continuation, "Claude interrupt phase has no active public continuation");
      const pending = input.ports.c.continueProcess(
        turn.continuation.input,
        turn.continuation.requestContextId,
      );
      await input.ports.interruptActiveTurn!({
        requestId: turn.requestId,
        nativeSessionId: turn.nativeSessionId,
      });
      await input.ports.waitForFinish(turn.requestId);
      const terminal = await input.ports.nativeTerminal({
        requestId: turn.requestId,
        nativeSessionId: turn.nativeSessionId,
      });
      assert(
        terminal.requestId === turn.requestId &&
          terminal.nativeSessionId === turn.nativeSessionId &&
          terminal.status === "interrupted",
        "Claude interruption lacks the exact native public terminal event",
      );
      await pending;
      continue;
    }

    let pending: Promise<HarnessProcessExecutionShardResult>;
    if (turn.runShard) {
      assert(
        turn.runShard.requestContextId === turn.requestId &&
          turn.runShard.input.processes.length === 1 &&
          turn.runShard.input.processes[0]?.processId === turn.processId,
        "Claude work request is not the exact one-process public C request",
      );
      const run = turn.runShard;
      if (receipts.length === 0) {
        pending = (input.timer ?? claudeQualificationColdTimer)
          .measureColdFirstSuccessfulRpc(() =>
            input.ports.c.runShard(run.input, run.requestContextId),
          )
          .then((measured) => {
            coldStartupUpperBound = measured.timing;
            return measured.value;
          });
      } else pending = input.ports.c.runShard(run.input, run.requestContextId);
    } else {
      assert(turn.continuation, "Claude public turn has no run or continuation request");
      assert(
        turn.continuation.requestContextId === turn.requestId &&
          turn.continuation.input.processId === turn.processId &&
          turn.continuation.input.runStore.request.requestId === turn.requestId,
        "Claude continuation request identity changed",
      );
      pending = input.ports.c.continueProcess(
        turn.continuation.input,
        turn.continuation.requestContextId,
      );
    }

    await Promise.race([
      input.ports.waitForFinish(turn.requestId),
      pending.then((result) => {
        throw new Error(
          `Claude C returned before its persisted checkpoint barrier: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const runStore = await input.ports.readRunStore();
    const entries = runStore.snapshot.requests?.entries ?? [];
    const matching = entries.filter((entry) => entry.request.requestId === turn.requestId);
    assert(
      matching.length === 1 &&
        matching[0]!.status === "completed" &&
        matching[0]!.finish?.status === "completed",
      "Claude public C request lacks one persisted successful finish",
    );
    const finish = matching[0]!.finish!;
    const files = await input.ports.materializeFiles(turn.requestId, finish.checkpoint.filesystem);
    assert(
      files.checkpointId === finish.checkpoint.filesystem.id && files.files.length > 0,
      "Claude public FilesStore checkpoint differs from the finished request",
    );
    const terminal = await input.ports.nativeTerminal({
      requestId: turn.requestId,
      nativeSessionId: turn.nativeSessionId,
    });
    assert(
      terminal.requestId === turn.requestId &&
        terminal.nativeSessionId === turn.nativeSessionId &&
        terminal.status === "completed",
      "Claude completed turn lacks its exact public native terminal event",
    );
    const checkpoint = await input.ports.checkpointInput({
      turn,
      runStore,
      files,
    });
    assert(
      checkpoint.requestId === turn.requestId &&
        checkpoint.nativeSessionId === turn.nativeSessionId &&
        checkpoint.processId === turn.processId &&
        checkpoint.checkpoint.checkpointId === files.checkpointId,
      "Claude checkpoint commit input does not match the public request evidence",
    );
    const commit = await input.ports.c.commitProcessCheckpoint(checkpoint);
    assert(
      typeof commit === "object" &&
        commit !== null &&
        Reflect.get(commit, "status") === "committed",
      "Claude C did not commit the actual FilesStore checkpoint",
    );
    const process = await pending;
    assert(
      process.processes.length === 1 &&
        process.processes[0]?.processId === turn.processId &&
        (process.processes[0]?.status === "idle" || process.processes[0]?.status === "settled"),
      "Claude C returned without the actual process result",
    );
    receipts.push({
      phase: turn.phase,
      requestId: turn.requestId,
      status: "committed",
      runStore,
      files,
      commit,
      shard: process,
      terminal,
    });
  }

  assert(coldStartupUpperBound, "The first successful public C RPC has no parent timing");
  return {
    schema: "signalbox/claude-qualification-public-c-workflow/v1",
    purpose: "qualification",
    variant: input.variant,
    lane,
    status: "observed",
    qualification: "pending",
    firstPublicCall: "runShard",
    coldStartupUpperBound,
    turns: receipts,
    interruption: {
      status: "pending",
      reason: needsInterrupt
        ? "The interrupted request event is verified; interruption cleanup and continuation semantics need the public interrupt authority result."
        : "No public interrupt step was supplied.",
    },
    criteria: [
      ...(["text", "readEdit", "bash", "grep", "resume", "mcp", "interrupt"] as const).map(
        (name) => ({
          name,
          status: "pending" as const,
          reason: "Public C receipts do not establish the matching Claude model tool result.",
        }),
      ),
      {
        name: "publicHarness" as const,
        status: "pending" as const,
        reason: "C request and checkpoint receipts are observed; qualification remains pending.",
      },
    ],
  };
}
