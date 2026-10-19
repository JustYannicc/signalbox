// @effect-diagnostics nodeBuiltinImport:off - disposable local workerd proof with persistent owned state.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { unstable_dev } from "wrangler";
import {
  createReceiptFile,
  createStageFile,
  currentSourceCommit,
  deriveProofToken,
  initialProofReceipt,
  mergeWorkerEvidence,
  newProofStage,
  proofOwner,
  readStageFile,
  requestProofWorker,
  workerEvidence,
} from "./Deployment.ts";
import { openLocalProofTunnel } from "./LocalTunnel.ts";
import { prepareProofSeed } from "./Seed.ts";

const options = NodeUtil.parseArgs({
  options: {
    "program-dir": { type: "string" },
    "stage-file": { type: "string" },
    "recover-stage-file": { type: "string" },
    output: { type: "string" },
  },
}).values;
const stagePath = options["recover-stage-file"] ?? options["stage-file"];
if (!stagePath || !options.output || (!options["recover-stage-file"] && !options["program-dir"])) {
  throw new Error(
    "Use --program-dir DIR --stage-file FILE --output FILE, or --recover-stage-file FILE --output FILE",
  );
}
const apiKey = process.env.BOXD_API_KEY;
if (!apiKey) throw new Error("BOXD_API_KEY is required");
const root = NodePath.resolve(import.meta.dirname, "../../../..");
const sourceCommit = await currentSourceCommit(root);
const stage = options["recover-stage-file"]
  ? await readStageFile(stagePath)
  : await createStageFile(stagePath, {
      version: 1,
      stage: newProofStage(),
      sourceCommit,
      phase: "created",
    });
if (stage.record.sourceCommit !== sourceCommit)
  throw new Error("Recover with the exact original proof source commit");
let receipt = initialProofReceipt(stage.record.stage, sourceCommit);
const writeReceipt = await createReceiptFile(options.output, receipt);
const save = async () => {
  await writeReceipt(receipt);
};
// Wrangler creates temporary files in the checkout, so freeze inputs before starting it.
const seed = options["recover-stage-file"]
  ? undefined
  : await prepareProofSeed(NodePath.resolve(options["program-dir"]!));
const stateDir = NodePath.resolve(NodePath.dirname(stagePath), `${stage.record.stage}-local-state`);
await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
const config = NodePath.resolve(stateDir, "wrangler.json");
await NodeFSP.writeFile(
  config,
  JSON.stringify({
    name: proofOwner(stage.record.stage),
    main: NodePath.resolve(import.meta.dirname, "worker.ts"),
    compatibility_date: "2026-06-04",
    compatibility_flags: ["nodejs_compat", "legacy_module_registry"],
    worker_loaders: [{ binding: "CHILD_WORKERS" }],
    durable_objects: { bindings: [{ name: "BOXD_PROOF", class_name: "ComputerBoxdProof" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ComputerBoxdProof"] }],
  }),
  { mode: 0o600 },
);
const token = deriveProofToken(apiKey, stage.record.stage);
const worker = await unstable_dev(NodePath.resolve(import.meta.dirname, "worker.ts"), {
  config,
  ip: "127.0.0.1",
  port: 0,
  inspectorPort: 0,
  local: true,
  envFiles: [],
  persist: true,
  persistTo: NodePath.resolve(stateDir, "storage"),
  logLevel: "none",
  vars: {
    BOXD_API_KEY: apiKey,
    BOXD_PROOF_TOKEN: token,
    BOXD_PROOF_OWNER: proofOwner(stage.record.stage),
  },
  experimental: { watch: false, disableDevRegistry: true, disableExperimentalWarning: true },
});
const origin = new URL(`http://127.0.0.1:${worker.port}`);
const request = async (route: "/status" | "/seed" | "/run" | "/recover", body?: unknown) => {
  const result = await requestProofWorker({
    url: origin,
    token,
    route,
    method: route === "/status" ? "GET" : "POST",
    signal: AbortSignal.timeout(route === "/recover" ? 120_000 : 30_000),
    ...(body === undefined ? {} : { body }),
  });
  receipt = mergeWorkerEvidence(receipt, result.body);
  await save();
  return workerEvidence(result.body, stage.record.stage);
};
let tunnel: Awaited<ReturnType<typeof openLocalProofTunnel>> | undefined;
let cleanupConfirmed = false;
let failed = false;
try {
  if (!options["recover-stage-file"]) {
    if (seed === undefined) throw new Error("Proof seed was not prepared");
    receipt = {
      ...receipt,
      inputs: {
        runnerSha256: seed.runner.sha256,
        runnerBytes: Buffer.byteLength(seed.runner.source),
        executableSha256s: seed.executables.map((file) => file.sha256),
      },
    };
    await save();
    await stage.update("seeding");
    await request("/seed", seed);
    tunnel = await openLocalProofTunnel(origin.href);
    const callback = new URL("/api/computer/runner", tunnel.url);
    callback.protocol = "wss:";
    await stage.update("running");
    let state = await request("/run", { runnerEndpoint: callback.href });
    const deadline = Date.now() + 600_000;
    while (state.status === "pending" || state.status === "running") {
      if (Date.now() > deadline) throw new Error("Local VM proof timed out");
      await new Promise((done) => setTimeout(done, 2_000));
      state = await request("/status");
    }
    failed = state.status !== "passed" || Object.values(state.checks).includes("failed");
    receipt = { ...receipt, checks: { ...receipt.checks, proofRun: failed ? "failed" : "passed" } };
    await save();
  }
} catch {
  failed = true;
  receipt = { ...receipt, checks: { ...receipt.checks, localProof: "failed" } };
  await save();
} finally {
  await stage.update("recovering");
  const deadline = Date.now() + 180_000;
  do {
    try {
      cleanupConfirmed = (await request("/recover", {})).cleanupConfirmed;
    } catch {
      /* Persisted ownership and the alarm remain available for recovery. */
    }
    if (!cleanupConfirmed) await new Promise((done) => setTimeout(done, 5_000));
  } while (!cleanupConfirmed && Date.now() < deadline);
  await stage.update(cleanupConfirmed ? "cleanup-confirmed" : "cleanup-unconfirmed");
  receipt = { ...receipt, cleanup: cleanupConfirmed ? "confirmed_absent" : "unconfirmed" };
  await save();
  await tunnel?.stop();
  // Persistent local DO state survives shutdown; only confirmed absence is a passing cleanup.
  await worker.stop();
}
console.log(
  JSON.stringify({ sourceCommit, status: failed ? "failed" : "passed", cleanupConfirmed }),
);
if (failed || !cleanupConfirmed) process.exitCode = 1;
