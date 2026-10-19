// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - the standalone CLI calls its disposable Worker over native HTTP.
import * as NodeCrypto from "node:crypto";
import { runProcess } from "../isolateProbe/process.ts";
import {
  COMPUTER_BOXD_PROOF_STAGE,
  ProofLauncherFailure,
  type SafeOutcome,
  type ProofReceipt,
} from "./ProofProtocol.ts";
export {
  COMPUTER_BOXD_PROOF_STAGE,
  ProofLauncherFailure,
  type StagePhase,
  type SafeOutcome,
  type CleanupState,
  type ProofReceipt,
} from "./ProofProtocol.ts";
export { createStageFile, readStageFile, createReceiptFile } from "./ProofFiles.ts";
const COMMIT = /^[a-f0-9]{40,64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function newProofStage() {
  return `computer-boxd-${NodeCrypto.randomBytes(8).toString("hex")}`;
}

export function proofOwner(stage: string) {
  if (!COMPUTER_BOXD_PROOF_STAGE.test(stage))
    throw new ProofLauncherFailure("Invalid proof stage.");
  return `sb-${stage}`;
}

export function deriveProofToken(apiKey: string, stage: string) {
  if (!apiKey) throw new ProofLauncherFailure("BOXD_API_KEY is required.");
  return NodeCrypto.createHmac("sha256", apiKey)
    .update(`signalbox:computer-boxd-proof:v1\0${stage}`)
    .digest("base64url");
}

export async function currentSourceCommit(repoDir: string) {
  try {
    const result = await runProcess({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: repoDir,
      env: { ...process.env },
      timeoutMs: 15_000,
    });
    const commit = result.stdout.trim();
    if (result.code !== 0 || !COMMIT.test(commit)) throw new Error("invalid commit");
    return commit;
  } catch {
    throw new ProofLauncherFailure("Could not identify the source commit.");
  }
}

export function initialProofReceipt(stage: string, sourceCommit: string): ProofReceipt {
  return {
    sourceCommit,
    stage,
    vmNames: [],
    checks: {
      launcherSetup: "pending",
      runnerBuild: "pending",
      seedPreparation: "pending",
      workerDeployment: "pending",
      workerStatus: "pending",
      seedUpload: "pending",
      proofRun: "pending",
      recovery: "pending",
      workerRemoval: "pending",
    },
    cleanup: "not_started",
  };
}

export function withCheck(receipt: ProofReceipt, name: string, outcome: SafeOutcome): ProofReceipt {
  return { ...receipt, checks: { ...receipt.checks, [name]: outcome } };
}

export interface WorkerEvidence {
  readonly vmNames: readonly string[];
  readonly checks: Readonly<Record<string, SafeOutcome>>;
  readonly cleanupConfirmed: boolean;
  readonly status: "pending" | "running" | "passed" | "failed";
}

export function workerEvidence(value: unknown, stage: string): WorkerEvidence {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "checks,cleanupConfirmed,status,vmNames" ||
    !["pending", "running", "passed", "failed"].includes(String(value.status)) ||
    !Array.isArray(value.vmNames) ||
    !isRecord(value.checks) ||
    typeof value.cleanupConfirmed !== "boolean"
  ) {
    throw new ProofLauncherFailure("The proof Worker returned invalid safe evidence.");
  }
  const owner = proofOwner(stage);
  const safeVm = new RegExp(`^computer-${owner}-(?:source|command-[1-9][0-9]*)$`);
  const names = new Set<string>();
  const checks: Record<string, SafeOutcome> = {};
  if (value.vmNames.length > 32)
    throw new ProofLauncherFailure("The proof Worker returned invalid safe evidence.");
  for (const candidate of value.vmNames) {
    if (typeof candidate !== "string" || !safeVm.test(candidate)) {
      throw new ProofLauncherFailure("The proof Worker returned an unowned VM name.");
    }
    if (names.has(candidate))
      throw new ProofLauncherFailure("The proof Worker returned duplicate VM names.");
    names.add(candidate);
  }
  for (const [name, outcome] of Object.entries(value.checks)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) ||
      !["pending", "passed", "failed", "skipped"].includes(String(outcome))
    ) {
      throw new ProofLauncherFailure("The proof Worker returned invalid safe evidence.");
    }
    checks[`worker_${name}`] = outcome as SafeOutcome;
  }
  return {
    status: value.status as WorkerEvidence["status"],
    vmNames: [...names].sort(),
    checks,
    cleanupConfirmed: value.cleanupConfirmed,
  };
}

export function mergeWorkerEvidence(receipt: ProofReceipt, value: unknown): ProofReceipt {
  const evidence = workerEvidence(value, receipt.stage);
  return {
    ...receipt,
    vmNames: [...new Set([...receipt.vmNames, ...evidence.vmNames])].sort(),
    checks: { ...receipt.checks, ...evidence.checks },
  };
}

export function extractWorkerUrl(output: string, stage: string): URL {
  const value = [...output.matchAll(/\burl:\s*(['"])(https:\/\/[^'"\s]+)\1/gu)].at(-1)?.[2];
  if (!value)
    throw new ProofLauncherFailure("Alchemy deploy failed to return the proof Worker URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProofLauncherFailure("Alchemy deploy returned an invalid proof Worker URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.hostname.split(".")[0] !== proofOwner(stage) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ProofLauncherFailure("Alchemy deploy returned a URL outside the proof Worker.");
  }
  return url;
}

export async function requestProofWorker(input: {
  readonly url: URL;
  readonly token: string;
  readonly route: "/status" | "/seed" | "/run" | "/recover";
  readonly method: "GET" | "POST";
  readonly signal: AbortSignal;
  readonly body?: unknown;
}) {
  let response: Response;
  try {
    response = await fetch(new URL(input.route, input.url), {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: input.signal,
      redirect: "error",
    });
  } catch {
    if (input.signal.aborted)
      throw new ProofLauncherFailure(`Worker ${input.route} was interrupted.`);
    throw new ProofLauncherFailure(`Worker ${input.route} failed (network error).`);
  }
  const expectedStatus = input.route === "/recover" || input.route === "/status" ? 200 : 202;
  if (response.status !== expectedStatus) {
    throw new ProofLauncherFailure(`Worker ${input.route} failed (HTTP ${response.status}).`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 1024 * 1024)
    throw new ProofLauncherFailure(`Worker ${input.route} returned an oversized response.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) {
    throw new ProofLauncherFailure(`Worker ${input.route} returned an oversized response.`);
  }
  if (!text.trim())
    throw new ProofLauncherFailure(`Worker ${input.route} returned empty safe evidence.`);
  try {
    return { httpStatus: response.status, body: JSON.parse(text) as unknown };
  } catch {
    throw new ProofLauncherFailure(`Worker ${input.route} returned invalid JSON.`);
  }
}
