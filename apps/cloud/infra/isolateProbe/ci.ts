// @effect-diagnostics nodeBuiltinImport:off - GitHub Actions entry point, never a local credential consumer.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ARCHIVE_SHA,
  RELEASE_TAG,
  SOURCE_PIN,
  downloadArchive,
  json,
  record,
  textField,
  unpackArchive,
  verifyInventories,
  writeJson,
} from "./ciArchive.ts";
import { Cloudflare, cleanupAll, ownedScript, type OwnedWorker } from "./ciCloudflare.ts";
import { runControls, successfulControls } from "./ciControls.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function ciOnly() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_ACTOR !== process.env.GITHUB_REPOSITORY_OWNER
  ) {
    throw new Error(
      "This pristine capture is restricted to an owner dispatch on main in GitHub Actions",
    );
  }
}

export async function main(cleanup = false) {
  ciOnly();
  const temp = required("RUNNER_TEMP");
  const output = NodePath.join(temp, "pristine-r4-evidence");
  const scratch = NodePath.join(temp, "pristine-r4-scratch");
  const ledger = NodePath.join(output, "owned-workers.json");
  await NodeFSP.mkdir(output, { recursive: true });
  const cloud = new Cloudflare(required("CLOUDFLARE_ACCOUNT_ID"), required("CLOUDFLARE_API_TOKEN"));
  if (cleanup) {
    const state = await json(ledger).catch((error: unknown) => {
      if (record(error).code === "ENOENT") return [];
      throw error;
    });
    if (!Array.isArray(state)) throw new Error("Malformed ownership ledger");
    const owners: OwnedWorker[] = state.map((item) => {
      const script = textField(item, "script");
      if (!ownedScript(script)) throw new Error("Unsafe ownership ledger");
      return { script, ...(record(item).deleted === true ? { deleted: true } : {}) };
    });
    await cleanupAll(cloud, owners, ledger);
    return;
  }
  await NodeFSP.mkdir(scratch, { recursive: true });
  const archive = NodePath.join(scratch, "inputs.tar.gz");
  await downloadArchive(
    required("GITHUB_REPOSITORY"),
    process.env.RELEASE_TAG ?? RELEASE_TAG,
    required("GH_TOKEN"),
    archive,
  );
  const root = await unpackArchive(archive, scratch);
  const inventories = await verifyInventories(root);
  await writeJson(NodePath.join(output, "inventory.json"), inventories.inventory);
  await writeJson(NodePath.join(output, "pinned-source-inventory.json"), inventories.source);
  await writeJson(NodePath.join(output, "inputs.json"), {
    archiveSHA256: ARCHIVE_SHA,
    sourcePin: SOURCE_PIN,
    helperCommit: required("GITHUB_SHA"),
    releaseTag: RELEASE_TAG,
    runId: required("GITHUB_RUN_ID"),
    nodeVersion: process.version,
  });
  await NodeFSP.symlink(
    NodePath.resolve(import.meta.dirname, "../../node_modules"),
    NodePath.join(root, "node_modules"),
    "dir",
  );
  const results = await runControls(
    cloud,
    root,
    inventories.host,
    required("PROBE_SECRET"),
    output,
    scratch,
    ledger,
  );
  if (!successfulControls(results)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === import.meta.filename) {
  await main(process.argv.includes("--cleanup")).catch(() => {
    process.stderr.write(
      "Pristine CI capture failed. Inspect the uploaded evidence and cleanup step.\n",
    );
    process.exitCode = 1;
  });
}
