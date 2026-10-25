import {
  HARNESS_RELEASE_RESULT_PATH as policyResultPath,
  HARNESS_RELEASE_WORKFLOW_FILE as policyWorkflowFile,
  canPromoteHarnessRelease as policyCanPromoteHarnessRelease,
  isVerifiedHarnessRelease as policyIsVerifiedHarnessRelease,
  ledgerProviderFor as policyLedgerProviderFor,
  releaseArtifactName as policyReleaseArtifactName,
  releaseReceiptDisposition as policyReleaseReceiptDisposition,
  releaseReceiptKey as policyReleaseReceiptKey,
  releaseRunKey as policyReleaseRunKey,
} from "./harnessReleasePolicy.ts";
import { workflowFunctionSource } from "./workflowFunctionSource.ts";

const HARNESS_RELEASE_RESULT_PATH = policyResultPath;
const HARNESS_RELEASE_WORKFLOW_FILE = policyWorkflowFile;
const canPromoteHarnessRelease = policyCanPromoteHarnessRelease;
const isVerifiedHarnessRelease = policyIsVerifiedHarnessRelease;
const ledgerProviderFor = policyLedgerProviderFor;
const releaseArtifactName = policyReleaseArtifactName;
const releaseReceiptDisposition = policyReleaseReceiptDisposition;
const releaseReceiptKey = policyReleaseReceiptKey;
const releaseRunKey = policyReleaseRunKey;

type RecordValue = Record<string, unknown>;
type ReleaseCandidate = {
  readonly id: string;
  readonly provider: "claude-code" | "claude-agent-sdk" | "codex";
  readonly version: string;
  readonly selection: "current" | "backfill";
};

type ReleaseWorkflowTools = {
  recall(label: string, key: string): Promise<unknown>;
  remember(label: string, key: string, value: unknown): Promise<unknown>;
  call(label: string, operation: string, args: Record<string, unknown>): Promise<unknown>;
  agent(label: string, options: { prompt: string }): Promise<unknown>;
};

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type WorkflowRun = {
  readonly runId: string;
  readonly url: string;
  readonly workflowFile: string;
  readonly headSha: string;
  readonly displayTitle: string;
  readonly status: string;
  readonly conclusion: string | null;
};

function workflowRun(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.url !== "string" ||
    typeof value.workflowFile !== "string" ||
    typeof value.headSha !== "string" ||
    typeof value.displayTitle !== "string" ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string")
  )
    return null;
  return {
    runId: value.runId,
    url: value.url,
    workflowFile: value.workflowFile,
    headSha: value.headSha,
    displayTitle: value.displayTitle,
    status: value.status,
    conclusion: value.conclusion,
  } satisfies WorkflowRun;
}

function verifiedWorkflowArtifact(
  value: unknown,
  candidate: ReleaseCandidate,
  headSha: string,
  runKey: string,
  expectedRun: ReturnType<typeof workflowRun>,
) {
  if (
    expectedRun === null ||
    !isRecord(value) ||
    !isRecord(value.run) ||
    !isRecord(value.artifact) ||
    typeof value.text !== "string"
  )
    return null;
  const run = workflowRun(value.run);
  const artifact = value.artifact;
  if (
    run === null ||
    run.runId !== expectedRun.runId ||
    run.workflowFile !== HARNESS_RELEASE_WORKFLOW_FILE ||
    run.headSha !== headSha ||
    run.displayTitle !== runKey ||
    run.status !== "completed" ||
    artifact.name !== releaseArtifactName(candidate.provider, candidate.version, run.runId) ||
    artifact.entryPath !== HARNESS_RELEASE_RESULT_PATH ||
    typeof artifact.id !== "string" ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
    typeof artifact.bytes !== "number" ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0
  )
    return null;

  try {
    const decoded: unknown = JSON.parse(value.text);
    if (
      !isRecord(decoded) ||
      decoded.schemaVersion !== 1 ||
      decoded.provider !== candidate.provider ||
      decoded.version !== candidate.version ||
      decoded.runKey !== runKey ||
      decoded.selection !== candidate.selection ||
      !isRecord(decoded.source) ||
      decoded.source.commit !== headSha ||
      (decoded.status !== "green" && decoded.status !== "red" && decoded.status !== "pending")
    )
      return null;
    if (decoded.status === "green" && run.conclusion !== "success") return null;
    return {
      run,
      artifact: {
        id: artifact.id,
        name: artifact.name,
        digest: artifact.digest,
        entryPath: artifact.entryPath,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      },
      result: decoded,
    };
  } catch {
    return null;
  }
}

async function updateReleaseThread(
  w: ReleaseWorkflowTools,
  threadId: string,
  previous: Record<string, unknown> | null,
  fingerprint: string,
  message: string,
) {
  if (previous?.threadUpdate === fingerprint) return fingerprint;
  try {
    await w.call("Update the release proof thread", "signalbox.t3_thread_send", {
      threadId,
      message,
    });
    return fingerprint;
  } catch {
    return previous?.threadUpdate ?? null;
  }
}

async function rememberPending(
  w: ReleaseWorkflowTools,
  receiptKey: string,
  fields: Record<string, unknown>,
) {
  await w.remember("Keep the release receipt pending", receiptKey, {
    ...fields,
    status: "pending",
  });
}

async function handoffRedProof(
  w: ReleaseWorkflowTools,
  receiptKey: string,
  receipt: RecordValue,
  candidate: ReleaseCandidate,
  runKey: string,
  headSha: string,
) {
  if (receipt.handoffStatus === "created") return receipt;

  const result = isRecord(receipt.result) ? receipt.result : {};
  const artifact = isRecord(receipt.workflowArtifact) ? receipt.workflowArtifact : null;
  const stages = Array.isArray(result.stages)
    ? result.stages
        .filter((stage) => isRecord(stage) && stage.status === "rejected")
        .map((stage) => (isRecord(stage) && typeof stage.name === "string" ? stage.name : null))
        .filter(Boolean)
        .join(", ")
    : "";
  let next: RecordValue;
  try {
    if (
      artifact === null ||
      typeof artifact.id !== "string" ||
      typeof artifact.sha256 !== "string" ||
      typeof receipt.workflowUrl !== "string"
    )
      throw new Error("The verified red proof receipt has no handoff details.");
    const issue = await w.call("Hand the failed proof to GitHub", "signalbox.github_issue", {
      action: "create",
      correlationId: `${runKey}:${headSha}:red`,
      title: `Harness proof failed: ${candidate.provider} ${candidate.version}`,
      body: [
        `The exact ${candidate.provider} ${candidate.version} proof returned red.`,
        `Run key: ${runKey}`,
        `Source head: ${headSha}`,
        `Workflow: ${receipt.workflowUrl}`,
        `Failed stages: ${stages || "not listed"}`,
        `Workflow artifact: ${artifact.id} (${artifact.sha256})`,
        "The previous green release remains selected.",
      ].join("\n\n"),
    });
    next = { ...receipt, handoffStatus: "created", handoff: issue };
  } catch {
    next = { ...receipt, handoffStatus: "unavailable" };
  }
  await w.remember("Store the red proof handoff", receiptKey, next);
  return next;
}

async function runRelease(
  w: ReleaseWorkflowTools,
  candidate: ReleaseCandidate,
  headSha: string,
  triggerAt: string,
) {
  const runKey = releaseRunKey(candidate.provider, candidate.version);
  const receiptKey = releaseReceiptKey(candidate.provider, candidate.version, headSha);
  const recalled = await w.recall("Read the release receipt", receiptKey);
  const previous: RecordValue | null =
    isRecord(recalled) && recalled.runKey === runKey && recalled.headSha === headSha
      ? recalled
      : null;
  const releaseThreadValue = await w.recall("Read the release tracking thread", runKey);
  const releaseThread =
    isRecord(releaseThreadValue) && releaseThreadValue.runKey === runKey
      ? releaseThreadValue
      : null;
  const disposition = releaseReceiptDisposition(previous, runKey, headSha);
  if (disposition === "reuse") {
    const reusable =
      candidate.selection === "current" && previous?.status === "red" && previous !== null
        ? await handoffRedProof(w, receiptKey, previous, candidate, runKey, headSha)
        : previous;
    const result = reusable !== null && isRecord(reusable.result) ? reusable.result : null;
    return {
      status: reusable?.status,
      reused: true,
      verified:
        reusable?.status === "green" &&
        reusable?.ledgerStatus === "recorded" &&
        reusable?.runtimeArtifactVerified === true &&
        result !== null &&
        isVerifiedHarnessRelease("green", result as Parameters<typeof isVerifiedHarnessRelease>[1]),
    };
  }

  let childThreadId =
    releaseThread !== null && typeof releaseThread.childThreadId === "string"
      ? releaseThread.childThreadId
      : previous !== null && typeof previous.childThreadId === "string"
        ? previous.childThreadId
        : null;
  if (childThreadId === null) {
    try {
      const child = await w.agent("Create a release proof thread", {
        prompt: [
          "This thread tracks one exact harness release attempt.",
          `Provider: ${candidate.provider}.`,
          `Version: ${candidate.version}.`,
          `Source head: ${headSha}.`,
          `Run key: ${runKey}.`,
          "The Signalbox automation owns GitHub dispatch, run readback and immutable artifact verification. Do not run external commands or claim a proof result. The automation will send the verified outcome to this thread.",
        ].join("\n\n"),
      });
      childThreadId = isRecord(child) && typeof child.threadId === "string" ? child.threadId : null;
      if (childThreadId !== null) {
        await w.remember("Keep the release tracking thread", runKey, {
          runKey,
          provider: candidate.provider,
          version: candidate.version,
          childThreadId,
        });
      }
    } catch {
      childThreadId = null;
    }
  }
  if (childThreadId === null) {
    await rememberPending(w, receiptKey, {
      ...previous,
      discoveryId: candidate.id,
      provider: candidate.provider,
      version: candidate.version,
      selection: candidate.selection,
      runKey,
      headSha,
      workflowStatus: previous?.workflowStatus ?? "not-started",
      reason: "The release proof thread could not be created.",
    });
    return { status: "pending", runKey, headSha };
  }

  let expectedRevision =
    previous !== null && typeof previous.expectedRevision === "number"
      ? previous.expectedRevision
      : null;
  if (expectedRevision === null) {
    try {
      const selection = await w.call(
        "Read the selected release revision",
        "signalbox.harness_release_ledger",
        { action: "selection", provider: ledgerProviderFor(candidate.provider) },
      );
      expectedRevision =
        isRecord(selection) && Number.isSafeInteger(selection.revision)
          ? (selection.revision as number)
          : null;
    } catch {
      expectedRevision = null;
    }
  }
  if (expectedRevision === null) {
    const threadUpdate = await updateReleaseThread(
      w,
      childThreadId,
      previous,
      `ledger-unavailable:${headSha}`,
      `The exact ${candidate.provider} ${candidate.version} proof is pending because its project ledger is unavailable. Run key: ${runKey}. Source head: ${headSha}.`,
    );
    await rememberPending(w, receiptKey, {
      ...previous,
      discoveryId: candidate.id,
      provider: candidate.provider,
      version: candidate.version,
      selection: candidate.selection,
      runKey,
      headSha,
      childThreadId,
      ledgerStatus: "unverified",
      workflowStatus: previous?.workflowStatus ?? "not-started",
      proofArtifactVerified: false,
      runtimeArtifactVerified: false,
      expectedRevision: null,
      threadUpdate,
      reason: "The project ledger could not capture a selection revision before proof started.",
    });
    return { status: "pending", runKey, headSha };
  }

  const workflowFile = HARNESS_RELEASE_WORKFLOW_FILE;
  let run: ReturnType<typeof workflowRun> = null;
  try {
    const response =
      disposition === "read" && previous !== null
        ? await w.call("Read the existing exact release run", "signalbox.github_workflow", {
            action: "read",
            workflowFile,
            runId: previous.workflowRunId,
            headSha,
          })
        : await w.call("Dispatch the exact release proof", "signalbox.github_workflow", {
            action: "dispatch",
            workflowFile,
            ref: "main",
            headSha,
            correlationId: runKey,
            inputs: {
              provider: candidate.provider,
              version: candidate.version,
              runKey,
              selection: candidate.selection,
            },
          });
    run = workflowRun(response);
  } catch {
    run = null;
  }

  if (
    run === null ||
    run.workflowFile !== workflowFile ||
    run.headSha !== headSha ||
    run.displayTitle !== runKey
  ) {
    const threadUpdate = await updateReleaseThread(
      w,
      childThreadId,
      previous,
      `workflow-unavailable:${headSha}`,
      `The exact ${candidate.provider} ${candidate.version} proof is pending. The automation could not confirm a workflow run for ${runKey} at ${headSha}.`,
    );
    await rememberPending(w, receiptKey, {
      ...previous,
      discoveryId: candidate.id,
      provider: candidate.provider,
      version: candidate.version,
      selection: candidate.selection,
      runKey,
      headSha,
      expectedRevision,
      childThreadId,
      ...(run === null ? {} : { workflowRunId: run.runId, workflowUrl: run.url }),
      ledgerStatus: "unverified",
      workflowStatus: run?.status ?? "unknown",
      proofArtifactVerified: false,
      runtimeArtifactVerified: false,
      threadUpdate,
      reason: "The workflow run did not match the exact release attempt.",
    });
    return { status: "pending", runKey, headSha };
  }

  const baseReceipt = {
    ...previous,
    discoveryId: candidate.id,
    provider: candidate.provider,
    version: candidate.version,
    selection: candidate.selection,
    runKey,
    headSha,
    expectedRevision,
    childThreadId,
    workflowRunId: run.runId,
    workflowUrl: run.url,
    workflowStatus: run.status,
  };
  if (run.status !== "completed") {
    await rememberPending(w, receiptKey, {
      ...baseReceipt,
      ledgerStatus: "unverified",
      proofArtifactVerified: false,
      runtimeArtifactVerified: false,
    });
    return { status: "pending", runKey, headSha, workflowStatus: run.status };
  }

  let evidence: unknown = null;
  try {
    evidence = await w.call(
      "Read the completed release proof artifact",
      "signalbox.github_workflow",
      {
        action: "artifact",
        workflowFile,
        runId: run.runId,
        headSha,
        artifactName: releaseArtifactName(candidate.provider, candidate.version, run.runId),
        entryPath: HARNESS_RELEASE_RESULT_PATH,
      },
    );
  } catch {
    evidence = null;
  }
  const verified = verifiedWorkflowArtifact(evidence, candidate, headSha, runKey, run);
  if (verified === null) {
    const reason =
      "The completed workflow's immutable result artifact is unavailable or mismatched.";
    const threadUpdate = await updateReleaseThread(
      w,
      childThreadId,
      previous,
      `completed-artifact-pending:${headSha}`,
      `The ${candidate.provider} ${candidate.version} workflow completed, but its exact result artifact could not be verified. Status remains pending. Run: ${run.url}`,
    );
    await rememberPending(w, receiptKey, {
      ...baseReceipt,
      ledgerStatus: "unverified",
      proofArtifactVerified: false,
      runtimeArtifactVerified: false,
      threadUpdate,
      reason,
    });
    return { status: "pending", runKey, headSha, workflowUrl: run.url, reason };
  }

  let recorded: unknown = null;
  try {
    recorded = await w.call(
      "Verify the immutable release result in the project ledger",
      "signalbox.harness_release_ledger",
      {
        action: "record",
        provider: ledgerProviderFor(candidate.provider),
        version: candidate.version,
        selection: candidate.selection,
        runKey,
        headSha,
        workflowFile,
        workflowRunId: run.runId,
        artifactName: verified.artifact.name,
        entryPath: verified.artifact.entryPath,
      },
    );
  } catch {
    recorded = null;
  }
  const ledgerRecorded = isRecord(recorded) && recorded.status === "recorded";
  const runtimeArtifactVerified = isRecord(recorded) && recorded.runtimeArtifactVerified === true;
  const result =
    isRecord(recorded) && isRecord(recorded.result) ? recorded.result : verified.result;
  const proofStatus =
    isRecord(recorded) && proofStatusOf(recorded.proofStatus) !== null
      ? proofStatusOf(recorded.proofStatus)
      : (proofStatusOf(verified.result.status) ?? "pending");
  const proofArtifactVerified = true;
  const status =
    proofStatus === "red" && proofArtifactVerified
      ? "red"
      : proofStatus === "green" &&
          ledgerRecorded &&
          runtimeArtifactVerified &&
          isVerifiedHarnessRelease(
            "green",
            result as Parameters<typeof isVerifiedHarnessRelease>[1],
          )
        ? "green"
        : "pending";
  const reason =
    isRecord(recorded) && typeof recorded.reason === "string"
      ? recorded.reason
      : status === "pending"
        ? "The immutable proof is verified, but its deployable runtime payload is not available yet."
        : undefined;
  let stored: RecordValue = {
    ...baseReceipt,
    status,
    proofStatus,
    ledgerStatus: ledgerRecorded ? "recorded" : "unverified",
    proofArtifactVerified,
    runtimeArtifactVerified,
    result,
    workflowArtifact: verified.artifact,
    threadUpdate: previous?.threadUpdate ?? null,
    ...(reason === undefined ? {} : { reason }),
  };

  if (status === "green" && candidate.selection === "current" && expectedRevision !== null) {
    try {
      const latest = await w.call(
        "Read the selected release revision",
        "signalbox.harness_release_ledger",
        { action: "selection", provider: ledgerProviderFor(candidate.provider) },
      );
      const currentRevision =
        isRecord(latest) && Number.isSafeInteger(latest.revision)
          ? (latest.revision as number)
          : null;
      if (
        !canPromoteHarnessRelease({
          selection: candidate.selection,
          status,
          runtimeArtifactVerified,
          expectedRevision,
          currentRevision,
          result,
        })
      ) {
        await rememberPending(w, receiptKey, {
          ...stored,
          promotionStatus: "stale",
          reason: "The captured selection revision changed while this proof ran.",
        });
        return { status: "pending", runKey, headSha, workflowUrl: run.url, promotion: "stale" };
      }
      await w.call("Select the proven current release", "signalbox.harness_release_ledger", {
        action: "promote",
        provider: ledgerProviderFor(candidate.provider),
        releaseId: result.candidateId,
        expectedRevision,
        changedAt: triggerAt,
      });
    } catch {
      await rememberPending(w, receiptKey, {
        ...stored,
        promotionStatus: "not-selected",
      });
      return { status: "pending", runKey, headSha, workflowUrl: run.url };
    }
  }

  if (status === "red" && candidate.selection === "current")
    stored = await handoffRedProof(w, receiptKey, stored, candidate, runKey, headSha);

  const threadMessage =
    status === "red"
      ? `The exact ${candidate.provider} ${candidate.version} proof is red. Run key: ${runKey}. Source head: ${headSha}. Workflow: ${run.url}. The previous green release remains selected.`
      : status === "green"
        ? `The exact ${candidate.provider} ${candidate.version} proof is green and selected. Run key: ${runKey}. Source head: ${headSha}. Workflow: ${run.url}.`
        : `The exact ${candidate.provider} ${candidate.version} proof is pending. Run key: ${runKey}. Source head: ${headSha}. Workflow: ${run.url}. ${reason ?? "The previous green release remains selected."}`;
  const threadUpdate = await updateReleaseThread(
    w,
    childThreadId,
    previous,
    `${headSha}:${run.status}:${status}:${proofStatus}:${runtimeArtifactVerified}`,
    threadMessage,
  );
  const finalReceipt = { ...stored, threadUpdate };
  await w.remember("Store the release proof status", receiptKey, finalReceipt);
  return {
    status,
    verified: status === "green" && runtimeArtifactVerified,
    proofStatus,
    proofArtifactVerified,
    runtimeArtifactVerified,
    workflowStatus: run.status,
    discoveryId: candidate.id,
    runKey,
    headSha,
    workflowUrl: run.url,
    ...(reason === undefined ? {} : { reason }),
  };
}

function proofStatusOf(value: unknown) {
  return value === "green" || value === "red" || value === "pending" ? value : null;
}

export const HARNESS_RELEASE_EXECUTION_SOURCE = [
  workflowFunctionSource(workflowRun),
  workflowFunctionSource(verifiedWorkflowArtifact),
  workflowFunctionSource(updateReleaseThread),
  workflowFunctionSource(rememberPending),
  workflowFunctionSource(handoffRedProof),
  workflowFunctionSource(proofStatusOf),
  workflowFunctionSource(runRelease),
].join("\n");
