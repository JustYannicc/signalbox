import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { prepareHarnessArtifact } from "./prepareArtifact.ts";
import { cloudflareHarnessArtifactStore, publishHarnessArtifact } from "./publishArtifact.ts";

const main = async () => {
  const { values } = NodeUtil.parseArgs({
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
      "artifact-hash": { type: "string" },
      "project-id": { type: "string" },
      prefix: { type: "string" },
      result: { type: "string" },
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
    const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const bucket = process.env.HARNESS_RELEASE_ARTIFACT_BUCKET ?? "";
    delete process.env.CLOUDFLARE_API_TOKEN;
    if (!values["artifact-hash"] || !values["source-identity"] || !values["project-id"])
      throw new Error("Pass the expected artifact hash, source identity and authorized project.");
    const store = cloudflareHarnessArtifactStore({ account, token, bucket });
    result = await publishHarnessArtifact(
      {
        artifactRef: `sha256:${values["artifact-hash"]}`,
        artifactHash: values["artifact-hash"],
        sourceIdentity: values["source-identity"],
      },
      output,
      {
        store,
        projectId: values["project-id"],
        ...(values.prefix ? { prefix: values.prefix } : {}),
      },
    );
  } else {
    throw new Error("Pass --mode prepare or --mode publish.");
  }
  await NodeFSP.writeFile(NodePath.resolve(values.result), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
};

if (process.argv[1] && (await NodeFSP.realpath(process.argv[1])) === import.meta.filename) {
  await main();
}
