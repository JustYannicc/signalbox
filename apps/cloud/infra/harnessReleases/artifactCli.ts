import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { prepareHarnessArtifact } from "./prepareArtifact.ts";
import { publishCodexRelease } from "./publishCodexRelease.ts";
import { publishClaudeVariants } from "./publishClaudeVariants.ts";

export const runHarnessArtifactCli = async (args: readonly string[]) => {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      mode: { type: "string" },
      harness: { type: "string" },
      "source-identity": { type: "string" },
      "computer-source-identity": { type: "string" },
      "computer-manifest-sha256": { type: "string" },
      codex: { type: "string" },
      cli: { type: "string" },
      sdk: { type: "string" },
      directory: { type: "string" },
      "assets-directory": { type: "string" },
      "artifact-hash": { type: "string" },
      release: { type: "string" },
      "project-id": { type: "string" },
      result: { type: "string" },
      ledger: { type: "string" },
      "baseline-directory": { type: "string" },
      "baseline-release": { type: "string" },
      "hooks-release": { type: "string" },
      "baseline-pin": { type: "string" },
      "max-prepared-module-bytes": { type: "string" },
      "expected-cli-manifest-sha256": { type: "string" },
    },
  });
  if (!values.directory || !values.result) throw new Error("Pass --directory and --result.");
  const output = NodePath.resolve(values.directory);
  let result: unknown;
  if (values.mode === "prepare") {
    if (
      (values.harness !== "codex" && values.harness !== "claude-code") ||
      !values["source-identity"] ||
      !values["computer-source-identity"] ||
      !values["computer-manifest-sha256"]
    )
      throw new Error("Pass a harness and its exact source and Computer identities.");
    result = await prepareHarnessArtifact({
      harness: values.harness,
      sourceIdentity: values["source-identity"],
      computer: {
        sourceIdentity: values["computer-source-identity"],
        manifestSha256: values["computer-manifest-sha256"],
      },
      components: {
        ...(values.codex ? { codex: NodePath.resolve(values.codex) } : {}),
        ...(values.cli ? { cli: NodePath.resolve(values.cli) } : {}),
        ...(values.sdk ? { sdk: NodePath.resolve(values.sdk) } : {}),
      },
      output,
    });
  } else if (values.mode === "publish") {
    if (
      values.harness !== "codex" ||
      !values.ledger ||
      !values.release ||
      !values["artifact-hash"] ||
      !values["source-identity"] ||
      !values["project-id"] ||
      !values["assets-directory"]
    )
      throw new Error(
        "Pass --harness codex, the qualified ledger/release, artifact hash, source identity, project and deployment assets directory. Claude publishes through publish-claude-variants.",
      );
    result = await publishCodexRelease({
      ledger: NodePath.resolve(values.ledger),
      releaseId: values.release,
      identity: {
        artifactRef: `sha256:${values["artifact-hash"]}`,
        artifactHash: values["artifact-hash"],
        sourceIdentity: values["source-identity"],
      },
      directory: output,
      projectId: values["project-id"],
      assetsDirectory: NodePath.resolve(values["assets-directory"]),
    });
  } else if (values.mode === "publish-claude-variants") {
    if (
      !values["assets-directory"] ||
      !values.ledger ||
      !values["baseline-directory"] ||
      !values["baseline-release"] ||
      !values["hooks-release"] ||
      !values["baseline-pin"] ||
      !values["computer-source-identity"] ||
      !values["computer-manifest-sha256"] ||
      !values["max-prepared-module-bytes"]
    )
      throw new Error(
        "Pass the ledger, both prepared releases, the saved baseline pin and trusted Computer/module allowance.",
      );
    const maxPreparedModuleBytes = Number(values["max-prepared-module-bytes"]);
    if (!Number.isSafeInteger(maxPreparedModuleBytes) || maxPreparedModuleBytes <= 0)
      throw new Error("CLAUDE_VARIANTS_MODULE_ALLOWANCE_INVALID");
    await publishClaudeVariants({
      assetsDirectory: NodePath.resolve(values["assets-directory"]),
      ledger: NodePath.resolve(values.ledger),
      ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
      baselineReleaseId: values["baseline-release"],
      hooksReleaseId: values["hooks-release"],
      baselineDirectory: NodePath.resolve(values["baseline-directory"]),
      hooksDirectory: output,
      baselinePin: NodePath.resolve(values["baseline-pin"]),
      trustedComputer: {
        sourceIdentity: values["computer-source-identity"],
        manifestSha256: values["computer-manifest-sha256"],
      },
      maxPreparedModuleBytes,
      output: NodePath.resolve(values.result),
      ...(values["expected-cli-manifest-sha256"]
        ? { expectedCliManifestSha256: values["expected-cli-manifest-sha256"] }
        : {}),
    });
    return;
  } else {
    throw new Error("Pass --mode prepare, publish or publish-claude-variants.");
  }
  await NodeFSP.writeFile(NodePath.resolve(values.result), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
};

if (process.argv[1] && (await NodeFSP.realpath(process.argv[1])) === import.meta.filename) {
  await runHarnessArtifactCli(process.argv.slice(2));
}
