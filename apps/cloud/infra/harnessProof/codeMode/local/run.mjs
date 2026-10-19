import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  root,
  require,
  sha,
  canonical,
  inside,
  verifyPins,
  snapshotTools,
  candidateInputs,
} from "./prepare.mjs";

const [freezeArg, outputFlag, outputArg, flag, expectedHash, ...extra] = process.argv.slice(2);
if (
  !freezeArg ||
  outputFlag !== "--output" ||
  !outputArg ||
  flag !== "--go" ||
  !/^[a-f0-9]{64}$/.test(expectedHash ?? "") ||
  extra.length
)
  throw new Error(
    "Root only: node run.mjs <fixture-freeze.json> --output <prepared-directory> --go <reviewed-freeze-sha256>",
  );
const freezePath = await NodeFSP.realpath(NodePath.resolve(freezeArg));
const outputRoot = await NodeFSP.realpath(NodePath.resolve(outputArg));
if (NodePath.dirname(freezePath) !== outputRoot || inside(await NodeFSP.realpath(root), outputRoot))
  throw new Error("Freeze must belong to the explicit output directory outside the checkout");
const freezeBytes = await NodeFSP.readFile(freezePath);
if (sha(freezeBytes) !== expectedHash) throw new Error("Reviewed freeze hash mismatch");
const frozen = JSON.parse(freezeBytes);
if (
  frozen.format !== "signalbox-code-mode-local-portable-v1" ||
  frozen.kind !== "actual-production-CodeMode-registered-kernel-process-proof"
)
  throw new Error("Unexpected proof freeze format");
if (sha(canonical(candidateInputs(frozen))) !== frozen.candidateSha256)
  throw new Error("Candidate identity mismatch");
if (
  frozen.sourcePins.length !== 29 ||
  sha(canonical(frozen.sourcePins)) !== frozen.sourceCandidate ||
  frozen.sourceCandidate !== "26fe43086901095106f293245d71f0558a628449767ee276d6d00600eb037876"
)
  throw new Error("Unaccepted CodeMode source candidate");
await verifyPins(root, [
  ...frozen.files,
  ...frozen.dependencies,
  ...frozen.sourcePins,
  ...frozen.compilerMetadata,
]);
await verifyPins(outputRoot, frozen.artifacts);
if (canonical((await snapshotTools()).pins) !== canonical(frozen.tools))
  throw new Error("Frozen tool drift");
const guard = await NodeFSP.open(NodePath.join(outputRoot, "actual-attempt-r1.lock"), "wx");
await guard.writeFile(
  JSON.stringify({ freezePath, freezeSha256: expectedHash, startedAt: new Date().toISOString() }) +
    "\n",
);
await guard.close();
const runId = NodeCrypto.randomBytes(16).toString("hex");
const output = NodePath.join(
  outputRoot,
  `actual-${new Date().toISOString().replace(/[:.]/g, "-")}-${runId}`,
);
await NodeFSP.mkdir(output);
const result = {
  runId,
  environment: "actual-local-workerd",
  fixtureSha256: expectedHash,
  startedAt: new Date().toISOString(),
  ok: false,
  phase: "harness-create",
  deadline: { milliseconds: 20000, aborted: false },
  harnessCleanup: "not-started",
  oldLifetime: "unknown",
  statusReads: 0,
};
let harness;
let endpoint;
let parsed;
const save = (name, value) =>
  NodeFSP.writeFile(NodePath.join(output, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
try {
  const { createTestHarness } = require("wrangler");
  harness = createTestHarness({
    workers: [{ configPath: NodePath.join(NodePath.dirname(freezePath), "wrangler.jsonc") }],
  });
  result.harnessCleanup = "pending";
  result.phase = "harness-listen";
  endpoint = (await harness.listen()).url;
  result.phase = "http-run";
  const abort = new AbortController();
  const deadline = setTimeout(() => {
    result.deadline.aborted = true;
    abort.abort(new Error("Actual proof HTTP deadline"));
  }, result.deadline.milliseconds);
  try {
    const response = await fetch(new URL("/run", endpoint), {
      method: "POST",
      signal: abort.signal,
    });
    const rawBody = await response.text();
    // The raw response is evidence even when parsing or validation fails.
    await save("raw-http.json", {
      httpStatus: response.status,
      headers: Object.fromEntries(response.headers),
      rawBody,
    });
    result.httpStatus = response.status;
    result.phase = "http-parse";
    parsed = JSON.parse(rawBody);
    result.value = parsed;
    if (!response.ok || parsed.ok !== true)
      throw new Error(parsed.failure?.error ?? parsed.error ?? `HTTP ${response.status}`);
    result.phase = "validate";
    if (
      parsed.capacityActive !== 0 ||
      parsed.processes !== 0 ||
      parsed.exit?.status !== "ok" ||
      parsed.exit?.value?.exitCode !== 0 ||
      parsed.exit?.value?.signal !== 0
    )
      throw new Error("Required registered process cleanup contract missing");
    result.ok = true;
    result.phase = "completed";
  } finally {
    clearTimeout(deadline);
  }
} catch (error) {
  result.error = String(error);
  result.stack = error?.stack;
  result.failure = { stage: result.phase, error: String(error) };
  process.exitCode = 1;
} finally {
  // One diagnostic recovery read, never a polling loop or an execution retry.
  if (endpoint && !result.ok) {
    result.statusReads = 1;
    try {
      const response = await fetch(new URL("/status", endpoint), {
        signal: AbortSignal.timeout(2000),
      });
      const rawBody = await response.text();
      await save("status-raw-http.json", { httpStatus: response.status, rawBody });
      try {
        result.status = JSON.parse(rawBody);
      } catch {
        result.statusParse = "invalid-json-raw-retained";
      }
    } catch (error) {
      result.statusError = String(error);
    }
  }
  if (harness) {
    try {
      await harness.close();
      result.harnessCleanup = "harness-closed";
    } catch (error) {
      result.harnessCleanup = "harness-close-failed";
      result.harnessCleanupError = String(error);
      result.ok = false;
      process.exitCode = 1;
    }
  }
  result.completedAt = new Date().toISOString();
  await save("actual-result.json", result);
  console.log(
    JSON.stringify({
      runId,
      ok: result.ok,
      phase: result.phase,
      failure: result.failure,
      harnessCleanup: result.harnessCleanup,
      oldLifetime: result.oldLifetime,
      output,
    }),
  );
}
