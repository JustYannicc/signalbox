import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { createProcessOperations } from "./process.ts";
import {
  cleanupReleaseDeployment,
  recoverReleaseCleanup,
  takeReleaseDeploymentCredentials,
} from "./deployment.ts";
import { assertReleaseSelection } from "./releaseIdentity.ts";
import { runRelease } from "./runner.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    provider: { type: "string" },
    version: { type: "string" },
    output: { type: "string" },
    baseline: { type: "string" },
    bash: { type: "string" },
    busybox: { type: "string" },
    ripgrep: { type: "string" },
    cleanup: { type: "boolean", default: false },
    "run-key": { type: "string" },
    selection: { type: "string", default: "current" },
  },
});
if (!values.output) throw new Error("Pass --output <new-directory-outside-the-repository>.");
const repository = NodePath.resolve(import.meta.dirname, "../..");
const deploymentCredentials = takeReleaseDeploymentCredentials();
if (values.cleanup) {
  const recovery = await recoverReleaseCleanup(
    repository,
    NodePath.resolve(values.output),
    (output) => cleanupReleaseDeployment(repository, output, deploymentCredentials),
  );
  process.stdout.write(`${JSON.stringify({ status: recovery.status })}\n`);
  if (recovery.status !== "passed") process.exitCode = 1;
} else {
  const provider = values.provider ?? "";
  const version = values.version ?? "";
  assertReleaseSelection(provider, version);
  const selection = values.selection;
  if (selection !== "current" && selection !== "backfill")
    throw new Error("RELEASE_SELECTION_INVALID");
  const result = await runRelease(
    {
      provider,
      version,
      output: values.output,
      selection,
      ...(values["run-key"] ? { runKey: values["run-key"] } : {}),
      repository,
    },
    createProcessOperations({
      ...(values.baseline ? { baseline: NodePath.resolve(values.baseline) } : {}),
      ...(values.bash ? { bash: NodePath.resolve(values.bash) } : {}),
      ...(values.busybox ? { busybox: NodePath.resolve(values.busybox) } : {}),
      ...(values.ripgrep ? { ripgrep: NodePath.resolve(values.ripgrep) } : {}),
      deploymentCredentials,
    }),
  );
  process.stdout.write(
    `${JSON.stringify({ runId: result.runId, status: result.status, publication: result.publication })}\n`,
  );
  process.exitCode = result.status === "green" ? 0 : result.status === "pending" ? 2 : 1;
}
