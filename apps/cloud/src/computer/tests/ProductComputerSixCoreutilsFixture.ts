// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Prepares a real WorkerLoader host for the ProductComputer test.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import { prepareChildPrograms } from "../../../infra/childPrograms/prepare.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { productComputerSixCoreutilsWorkerSource } from "./ProductComputerSixCoreutilsWorkerSource.ts";

export async function startProductComputerSixCoreutilsFixture() {
  const worktreeRoot = NodePath.resolve(import.meta.dirname, "../../../../../");
  const cloudRoot = NodePath.join(worktreeRoot, "apps/cloud");
  const programDir = NodePath.join(worktreeRoot, ".t3/issue-1255-coreutils-six/programs");
  const workerDir = NodePath.join(worktreeRoot, ".t3/issue-1255-coreutils-six/test-worker");
  const prepared = await prepareChildPrograms({ programDir, cloudRoot });
  const artifacts = new Map(
    prepared.sourceInventory.artifacts
      .filter(({ path }) => path.endsWith(".wasm"))
      .map(({ path, bytes, sha256 }) => [path, { path, bytes, sha256 }]),
  );
  if (!artifacts.has("jq.wasm") || !artifacts.has("product-busybox.wasm"))
    throw new Error("Prepared six-command catalog omitted a required WASM artifact");
  const moduleArtifacts = [...artifacts.values()].filter(
    (artifact, index, values) =>
      values.findIndex((candidate) => candidate.sha256 === artifact.sha256) === index,
  );

  await NodeFSP.rm(workerDir, { recursive: true, force: true });
  await NodeFSP.mkdir(workerDir, { recursive: true });
  const workerProgramsDir = NodePath.join(workerDir, "programs");
  for (const { path } of moduleArtifacts) {
    const destination = NodePath.join(workerProgramsDir, path);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.link(NodePath.join(programDir, path), destination);
  }
  await NodeFSP.writeFile(
    NodePath.join(workerDir, "programs.json"),
    `${JSON.stringify(prepared.programs)}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(workerDir, "fixtures.json"),
    `${JSON.stringify({
      passwd: "signalbox:x:1234:5678:Signalbox test:/home/signalbox:/bin/sh\n",
      group: "agents:x:5678:signalbox\n",
      lines: "b\na\nc\n",
      repeated: "a\na\nb\n",
      object: '{"answer":42}\n',
      shadow: "printf 'UPPER_PATH\\n'\n",
    })}\n`,
  );

  const executablePaths = [
    "bash",
    "sh",
    "cat",
    "grep",
    "touch",
    "rg",
    "sed",
    "echo",
    "printf",
    "ls",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "pwd",
    "head",
    "tail",
    "env",
    "id",
    "wc",
    "sort",
    "uniq",
    "jq",
  ].flatMap((name) => [`/bin/${name}`, `/usr/bin/${name}`]);
  executablePaths.push("/usr/bin/git");
  const inventory = {
    ...machineInventoryFixture(
      [...new Set(executablePaths)].map((path) => ({ path, mode: 0o755, uid: 0, gid: 0 })),
    ),
    path: ["/usr/bin", "/bin"],
  };
  await NodeFSP.writeFile(
    NodePath.join(workerDir, "inventory.json"),
    `${JSON.stringify(inventory)}\n`,
  );

  const hostPath = NodePath.join(workerDir, "host.ts");
  await NodeFSP.writeFile(
    hostPath,
    productComputerSixCoreutilsWorkerSource({
      cloudRoot,
      workerDir,
      artifacts: moduleArtifacts,
    }),
  );
  await build({
    entryPoints: [hostPath],
    absWorkingDir: worktreeRoot,
    outfile: NodePath.join(workerDir, "host.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    external: [
      "cloudflare:workers",
      "node:*",
      ...moduleArtifacts.map(({ path }) => `./programs/${path}`),
    ],
  });

  const configPath = NodePath.join(workerDir, "wrangler.jsonc");
  await NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      name: "signalbox-six-coreutils-productcomputer",
      main: "host.js",
      no_bundle: true,
      compatibility_date: "2026-10-19",
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
      rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
      durable_objects: { bindings: [{ name: "PROBE", class_name: "SixCoreutilsProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["SixCoreutilsProbe"] }],
    }),
  );

  const harness = createTestHarness({ workers: [{ configPath }] });
  const endpoint = (await harness.listen()).url;
  return {
    endpoint,
    async close() {
      try {
        await harness.close();
      } finally {
        await NodeFSP.rm(workerDir, { recursive: true, force: true });
      }
    },
  };
}
