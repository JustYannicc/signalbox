// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - the standalone CLI owns deployment deadlines and recovery polling.
import { proofInputEvidence } from "./InputEvidence.ts";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { runProcess } from "../isolateProbe/process.ts";
import {
  ProofLauncherFailure,
  createReceiptFile,
  createStageFile,
  currentSourceCommit,
  deriveProofToken,
  extractWorkerUrl,
  initialProofReceipt,
  mergeWorkerEvidence,
  newProofStage,
  proofOwner,
  readStageFile,
  requestProofWorker,
  workerEvidence,
  withCheck,
  type CleanupState,
  type ProofReceipt,
  type SafeOutcome,
} from "./Deployment.ts";

const cloudDir = NodePath.resolve(import.meta.dirname, "../..");
const repoDir = NodePath.resolve(cloudDir, "../..");
const stack = "infra/computer-boxd-proof.alchemy.ts";
const RUNNER_DIR = NodePath.join(repoDir, "apps/server");
const RUN_MS = 22 * 60_000;
const RECOVERY_MS = 10 * 60_000;
const COMMAND_MS = 10 * 60_000;
const STATUS_POLL_MS = 5_000;

type StageHandle = Awaited<ReturnType<typeof createStageFile>>;
type ReceiptWriter = Awaited<ReturnType<typeof createReceiptFile>>;
interface Context {
  stageFile: StageHandle;
  receipt: ProofReceipt;
  writeReceipt: ReceiptWriter;
  env: NodeJS.ProcessEnv;
  token: string;
  signal: AbortSignal;
  workerUrl?: URL;
}
interface RunOptions {
  programDir: string;
  stageFile: string;
  output: string;
}
interface RecoverOptions {
  recoverStageFile: string;
  output: string;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ProofLauncherFailure("Proof operation was interrupted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => done();
    if (signal.aborted) return done();
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function save(context: Context, receipt: ProofReceipt) {
  await context.writeReceipt(receipt);
  context.receipt = receipt;
}

async function check(context: Context, name: string, outcome: SafeOutcome, cleanup?: CleanupState) {
  const next = withCheck(context.receipt, name, outcome);
  await save(context, cleanup === undefined ? next : { ...next, cleanup });
}

async function mergeStatus(context: Context, value: unknown) {
  const evidence = workerEvidence(value, context.stageFile.record.stage);
  let receipt = mergeWorkerEvidence(context.receipt, value);
  const checks = { ...receipt.checks, workerStatus: "passed" as const };
  if (evidence.status === "passed" || evidence.status === "failed") {
    receipt = withCheck({ ...receipt, checks }, "proofRun", evidence.status);
  } else {
    receipt = { ...receipt, checks };
  }
  await save(context, receipt);
  return evidence;
}

function envFor(stage: string, apiKey: string) {
  const env = { ...process.env };
  env.BOXD_API_KEY = apiKey;
  env.BOXD_PROOF_TOKEN = deriveProofToken(apiKey, stage);
  env.BOXD_PROOF_OWNER = proofOwner(stage);
  return env;
}

async function alchemy(action: "deploy" | "destroy", context: Context) {
  try {
    const result = await runProcess({
      command: NodePath.join(cloudDir, "node_modules/.bin/alchemy"),
      args: [action, stack, "--stage", context.stageFile.record.stage, "--yes", "--no-input"],
      cwd: cloudDir,
      env: context.env,
      timeoutMs: COMMAND_MS,
      signal: context.signal,
    });
    if (result.code !== 0) {
      throw new ProofLauncherFailure(
        `Alchemy ${action} failed (exit ${result.code === null ? "unknown" : result.code}).`,
      );
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof ProofLauncherFailure) throw error;
    throw new ProofLauncherFailure(`Alchemy ${action} failed (process error).`);
  }
}

async function buildRunner(context: Context) {
  try {
    const env = { ...process.env };
    delete env.BOXD_API_KEY;
    delete env.BOXD_PROOF_TOKEN;
    delete env.BOXD_PROOF_OWNER;
    const result = await runProcess({
      command: process.execPath,
      args: ["runner-command.config.ts"],
      cwd: RUNNER_DIR,
      env,
      timeoutMs: COMMAND_MS,
      signal: context.signal,
    });
    if (result.code !== 0) {
      throw new ProofLauncherFailure(
        `Command runner build failed (exit ${result.code === null ? "unknown" : result.code}).`,
      );
    }
  } catch (error) {
    if (error instanceof ProofLauncherFailure) throw error;
    throw new ProofLauncherFailure("Command runner build failed.");
  }
}

async function seedFor(programDir: string) {
  try {
    // Keep Seed.ts unevaluated until the standalone command runner has been built.
    const { prepareProofSeed } = await import("./Seed.ts");
    return await prepareProofSeed(programDir);
  } catch {
    throw new ProofLauncherFailure("Proof seed preparation failed.");
  }
}

async function ensureWorker(context: Context) {
  if (context.workerUrl) return context.workerUrl;
  const output = await alchemy("deploy", context);
  context.workerUrl = extractWorkerUrl(output, context.stageFile.record.stage);
  return context.workerUrl;
}

async function status(context: Context) {
  return requestProofWorker({
    url: context.workerUrl!,
    token: context.token,
    route: "/status",
    method: "GET",
    signal: context.signal,
  });
}

async function waitReady(context: Context) {
  const until = Date.now() + 90_000;
  let last: ProofLauncherFailure | undefined;
  while (!context.signal.aborted) {
    try {
      const response = await status(context);
      await mergeStatus(context, response.body);
      return;
    } catch (error) {
      if (!(error instanceof ProofLauncherFailure)) throw error;
      last = error;
      if (!/network error|HTTP (?:404|429|5\d\d)/u.test(error.safeMessage)) throw error;
      if (Date.now() >= until) break;
      await delay(2_000, context.signal);
    }
  }
  throw new ProofLauncherFailure(last?.safeMessage ?? "Worker /status failed (readiness timeout).");
}

async function runAndWait(context: Context, seed: Awaited<ReturnType<typeof seedFor>>) {
  const response = await requestProofWorker({
    url: context.workerUrl!,
    token: context.token,
    route: "/run",
    method: "POST",
    body: { seed },
    signal: context.signal,
  });
  let evidence = workerEvidence(response.body, context.stageFile.record.stage);
  if (evidence.status !== "pending" && evidence.status !== "running") {
    throw new ProofLauncherFailure("Worker /run did not start the proof.");
  }
  await save(context, mergeWorkerEvidence(context.receipt, response.body));
  await check(context, "proofRun", "pending", "pending");
  while (
    !context.signal.aborted &&
    (evidence.status === "pending" || evidence.status === "running")
  ) {
    await delay(STATUS_POLL_MS, context.signal);
    const current = await status(context);
    evidence = await mergeStatus(context, current.body);
  }
  if (context.signal.aborted) throw new ProofLauncherFailure("Proof run was interrupted.");
  const passed = evidence.status === "passed" && !Object.values(evidence.checks).includes("failed");
  await check(context, "proofRun", passed ? "passed" : "failed", "pending");
  if (!passed) throw new ProofLauncherFailure("The proof Worker reported a failed run.");
}

async function recoverAndDestroy(
  context: Context,
): Promise<"destroyed" | "unconfirmed" | "worker-retained"> {
  try {
    await context.stageFile.update("recovering");
    await check(context, "recovery", "pending", "pending");
    await ensureWorker(context);
    try {
      const current = await status(context);
      await mergeStatus(context, current.body);
    } catch {
      await check(context, "workerStatus", "unknown");
    }
    const response = await requestProofWorker({
      url: context.workerUrl!,
      token: context.token,
      route: "/recover",
      method: "POST",
      body: {},
      signal: context.signal,
    });
    const evidence = workerEvidence(response.body, context.stageFile.record.stage);
    const merged = mergeWorkerEvidence(context.receipt, response.body);
    const proofStatus =
      evidence.status === "passed" || evidence.status === "failed"
        ? withCheck(merged, "proofRun", evidence.status)
        : merged;
    await save(context, proofStatus);
    if (evidence.cleanupConfirmed !== true) {
      await context.stageFile.update("cleanup-unconfirmed");
      await check(context, "recovery", "failed", "unconfirmed");
      await check(context, "workerRemoval", "skipped");
      return "unconfirmed";
    }
    await save(context, { ...context.receipt, cleanup: "confirmed_absent" });
    await context.stageFile.update("cleanup-confirmed");
  } catch {
    await context.stageFile.update("cleanup-unconfirmed").catch(() => undefined);
    await check(context, "recovery", "failed", "unconfirmed").catch(() => undefined);
    await check(context, "workerRemoval", "skipped").catch(() => undefined);
    return "unconfirmed";
  }

  try {
    await context.stageFile.update("destroying");
    await alchemy("destroy", context);
    await context.stageFile.update("destroyed");
    await check(context, "recovery", "passed", "worker_destroyed");
    await check(context, "workerRemoval", "passed", "worker_destroyed");
    return "destroyed";
  } catch {
    await check(context, "workerRemoval", "failed", "worker_retained").catch(() => undefined);
    return "worker-retained";
  }
}

async function runProof(options: RunOptions, signal: AbortSignal) {
  const stage = newProofStage();
  const sourceCommit = await currentSourceCommit(repoDir);
  const stageFile = await createStageFile(options.stageFile, {
    version: 1,
    stage,
    sourceCommit,
    phase: "created",
  });
  let receipt = initialProofReceipt(stage, sourceCommit);
  const writeReceipt = await createReceiptFile(options.output, receipt);
  const apiKey = process.env.BOXD_API_KEY;
  const context: Context = {
    stageFile,
    receipt,
    writeReceipt,
    env: apiKey ? envFor(stage, apiKey) : { ...process.env },
    token: apiKey ? deriveProofToken(apiKey, stage) : "",
    signal,
  };
  let deploymentAttempted = false;
  let activeCheck = "launcherSetup";
  let failure: ProofLauncherFailure | undefined;

  try {
    if (!apiKey) throw new ProofLauncherFailure("BOXD_API_KEY is required.");
    await check(context, "launcherSetup", "passed");
    activeCheck = "runnerBuild";
    await stageFile.update("building-runner");
    await buildRunner(context);
    await check(context, "runnerBuild", "passed");
    activeCheck = "seedPreparation";
    await stageFile.update("preparing-seed");
    const seed = await seedFor(NodePath.resolve(options.programDir));
    await save(context, {
      ...context.receipt,
      inputs: proofInputEvidence(seed),
    });
    await check(context, "seedPreparation", "passed");
    activeCheck = "workerDeployment";
    await stageFile.update("deploying");
    deploymentAttempted = true;
    const output = await alchemy("deploy", context);
    context.workerUrl = extractWorkerUrl(output, stage);
    await stageFile.update("deployed");
    await check(context, "workerDeployment", "passed", "pending");
    activeCheck = "workerStatus";
    await waitReady(context);
    activeCheck = "seedUpload";
    await stageFile.update("seeding");
    const seedResponse = await requestProofWorker({
      url: context.workerUrl,
      token: context.token,
      route: "/seed",
      method: "POST",
      body: seed,
      signal,
    });
    const seedEvidence = workerEvidence(seedResponse.body, stage);
    if (seedEvidence.status !== "pending") {
      throw new ProofLauncherFailure("Worker /seed did not leave the proof pending.");
    }
    await save(context, mergeWorkerEvidence(context.receipt, seedResponse.body));
    const seededStatus = await status(context);
    const seededEvidence = await mergeStatus(context, seededStatus.body);
    if (seededEvidence.status !== "pending") {
      throw new ProofLauncherFailure("Worker status changed before proof execution.");
    }
    await check(context, "seedUpload", "passed", "pending");
    activeCheck = "proofRun";
    await stageFile.update("running");
    await save(context, { ...context.receipt, cleanup: "pending" });
    await runAndWait(context, seed);
  } catch (error) {
    failure =
      error instanceof ProofLauncherFailure
        ? error
        : new ProofLauncherFailure("Computer boxd proof failed.");
    await check(
      context,
      activeCheck,
      "failed",
      deploymentAttempted ? "pending" : "not_started",
    ).catch(() => undefined);
    await stageFile
      .update(deploymentAttempted ? "failed-after-deploy" : "failed-before-deploy")
      .catch(() => undefined);
  }

  if (deploymentAttempted) {
    // A cancelled final run still gets its separate bounded recovery window.
    context.signal = AbortSignal.timeout(RECOVERY_MS);
    const cleanup = await recoverAndDestroy(context);
    if (cleanup !== "destroyed" && !failure) {
      failure = new ProofLauncherFailure(
        cleanup === "worker-retained"
          ? "VMs are absent, but the proof Worker could not be removed."
          : "VM cleanup was not confirmed; the proof Worker was retained.",
      );
    }
  }

  if (failure) throw failure;
  return context.receipt;
}

async function recoverProof(options: RecoverOptions, signal: AbortSignal) {
  const stageFile = await readStageFile(options.recoverStageFile);
  const record = stageFile.record;
  let receipt = initialProofReceipt(record.stage, record.sourceCommit);
  const writeReceipt = await createReceiptFile(options.output, receipt);
  const context: Context = {
    stageFile,
    receipt,
    writeReceipt,
    env: { ...process.env },
    token: "",
    signal,
  };
  if (record.phase === "destroyed") {
    await check(context, "recovery", "passed", "worker_destroyed");
    await check(context, "workerRemoval", "passed", "worker_destroyed");
    return;
  }
  if (
    ["created", "building-runner", "preparing-seed", "failed-before-deploy"].includes(record.phase)
  ) {
    await check(context, "recovery", "skipped", "not_started");
    await check(context, "workerRemoval", "skipped", "not_started");
    return;
  }

  const apiKey = process.env.BOXD_API_KEY;
  if (!apiKey) {
    await check(context, "recovery", "failed", "unconfirmed");
    await check(context, "workerRemoval", "skipped");
    throw new ProofLauncherFailure("BOXD_API_KEY is required for recovery.");
  }
  context.env = envFor(record.stage, apiKey);
  context.token = deriveProofToken(apiKey, record.stage);
  if (record.phase === "cleanup-confirmed" || record.phase === "destroying") {
    await save(context, { ...context.receipt, cleanup: "confirmed_absent" });
    try {
      await stageFile.update("destroying");
      await alchemy("destroy", context);
      await stageFile.update("destroyed");
      await check(context, "recovery", "passed", "worker_destroyed");
      await check(context, "workerRemoval", "passed", "worker_destroyed");
      return;
    } catch {
      await check(context, "recovery", "failed", "confirmed_absent").catch(() => undefined);
      await check(context, "workerRemoval", "failed", "worker_retained").catch(() => undefined);
      throw new ProofLauncherFailure("Worker removal failed; the proof Worker was retained.");
    }
  }

  const result = await recoverAndDestroy(context);
  if (result !== "destroyed") {
    throw new ProofLauncherFailure(
      result === "worker-retained"
        ? "VMs are absent, but the proof Worker could not be removed."
        : "VM cleanup was not confirmed; the proof Worker was retained.",
    );
  }
}

function parseOptions(argv: string[]): RunOptions | RecoverOptions {
  const { values } = NodeUtil.parseArgs({
    args: argv,
    options: {
      "program-dir": { type: "string" },
      "stage-file": { type: "string" },
      "recover-stage-file": { type: "string" },
      output: { type: "string" },
    },
    allowPositionals: false,
  });
  const output = values.output;
  if (!output) throw new ProofLauncherFailure("Pass --output FILE.");
  if (values["recover-stage-file"]) {
    if (values["program-dir"] || values["stage-file"]) {
      throw new ProofLauncherFailure("Recovery accepts only --recover-stage-file and --output.");
    }
    return { recoverStageFile: values["recover-stage-file"], output } satisfies RecoverOptions;
  }
  if (!values["program-dir"] || !values["stage-file"]) {
    throw new ProofLauncherFailure("Pass --program-dir DIR, --stage-file FILE, and --output FILE.");
  }
  return {
    programDir: values["program-dir"],
    stageFile: values["stage-file"],
    output,
  } satisfies RunOptions;
}

export async function main(argv = process.argv.slice(2)) {
  let interrupted: NodeJS.Signals | undefined;
  const controller = new AbortController();
  const sigint = () => {
    interrupted = "SIGINT";
    controller.abort();
  };
  const sigterm = () => {
    interrupted = "SIGTERM";
    controller.abort();
  };
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    const options = parseOptions(argv);
    if ("programDir" in options) {
      await runProof(options, AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_MS)]));
    } else {
      await recoverProof(
        options,
        AbortSignal.any([controller.signal, AbortSignal.timeout(RECOVERY_MS)]),
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof ProofLauncherFailure ? error.safeMessage : "Computer boxd proof launcher failed."}\n`,
    );
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodePath.resolve(import.meta.filename)
) {
  await main();
}
