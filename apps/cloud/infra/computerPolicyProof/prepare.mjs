// @effect-diagnostics nodeBuiltinImport:off - prepares a hash-pinned local proof fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import { COMPUTER_ISOLATE_EXECUTABLES } from "../../src/computer/EscalationPolicy.ts";
import { prepareChildPrograms } from "../childPrograms/prepare.ts";

const CLOUD_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const WORKTREE_ROOT = NodePath.resolve(CLOUD_ROOT, "../..");
const SOURCE_PATHS = [
  "infra/computerPolicyProof/prepare.mjs",
  "infra/computerPolicyProof/proof-source.ts",
  "infra/childPrograms/prepare.ts",
  "infra/childPrograms/runtime.ts",
  "src/computer/ChildProgramCatalog.ts",
  "src/computer/ComputerCommands.ts",
  "src/computer/EscalationPolicy.ts",
  "src/computer/EscalationTable.ts",
];

function requiredPath(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required input ${name}`);
  }
  return NodePath.resolve(value);
}

function requiredOutputPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Missing required input --output");
  }
  return NodePath.isAbsolute(value)
    ? NodePath.resolve(value)
    : NodePath.resolve(WORKTREE_ROOT, value);
}

function digest(bytes) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function isWithin(parent, candidate) {
  const relative = NodePath.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    relative !== ".." &&
    !NodePath.isAbsolute(relative)
  );
}

function isWithinOrSame(parent, candidate) {
  return parent === candidate || isWithin(parent, candidate);
}

async function writeExclusive(path, bytes) {
  const file = await NodeFSP.open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
}

async function sourceRecords(paths) {
  const records = [];
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await NodeFSP.readFile(NodePath.join(CLOUD_ROOT, path));
    records.push({ path, bytes: bytes.byteLength, sha256: digest(bytes) });
  }
  return records;
}

function sameRecords(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function prepareComputerPolicyFixture({ programsPath, outputPath }) {
  const programDir = await NodeFSP.realpath(requiredPath("--programs", programsPath));
  const outputDir = requiredOutputPath(outputPath);
  const allowedRoot = NodePath.join(WORKTREE_ROOT, ".t3");
  if (!isWithin(allowedRoot, outputDir)) {
    throw new Error(
      "Computer policy fixture output must be a new directory under this worktree .t3",
    );
  }
  if (NodePath.dirname(outputDir) !== allowedRoot) {
    throw new Error("Computer policy fixture output must be a direct child of this worktree .t3");
  }
  try {
    await NodeFSP.lstat(outputDir);
    throw new Error("Computer policy fixture output already exists; choose a fresh path");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const worktreeReal = await NodeFSP.realpath(WORKTREE_ROOT);
  const allowedRootReal = await NodeFSP.realpath(allowedRoot);
  if (!isWithin(worktreeReal, allowedRootReal)) {
    throw new Error("This worktree .t3 path resolves outside the registered worktree");
  }
  const outputParent = await NodeFSP.realpath(NodePath.dirname(outputDir));
  if (!isWithinOrSame(allowedRootReal, outputParent)) {
    throw new Error("Computer policy fixture output parent escapes this worktree .t3");
  }
  await NodeFSP.mkdir(outputDir, { recursive: false });

  const written = [];
  try {
    const children = await prepareChildPrograms({ programDir, cloudRoot: CLOUD_ROOT });
    const childSourcePaths = children.sourceInventory.sources
      .map(({ path }) => path)
      .filter((path) => !path.startsWith("generated/"));
    const frozenSourcePaths = [...new Set([...childSourcePaths, ...SOURCE_PATHS])].sort();
    const sourceBefore = await sourceRecords(frozenSourcePaths);
    for (const record of children.sourceInventory.sources) {
      if (record.path.startsWith("generated/")) continue;
      const current = sourceBefore.find((item) => item.path === record.path);
      if (!current || current.sha256 !== record.sha256 || current.bytes !== record.bytes) {
        throw new Error(`Child program source changed while it was being prepared: ${record.path}`);
      }
    }

    const programsDir = NodePath.join(outputDir, "programs");
    await NodeFSP.mkdir(programsDir, { recursive: false });
    const artifacts = new Map([
      ["/bin/bash", "bash.wasm"],
      ["/bin/cat", "busybox.wasm"],
      ["/bin/rg", "rg.wasm"],
    ]);
    for (const executable of children.executableFiles) {
      const fileName = artifacts.get(executable.path);
      if (fileName === undefined) throw new Error(`Unexpected child executable ${executable.path}`);
      const bytes = Buffer.from(executable.bytes);
      await writeExclusive(NodePath.join(programsDir, fileName), bytes);
      written.push({
        path: `programs/${fileName}`,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
      });
    }

    const sourceBundle = jsonBytes({
      bash: children.bash,
      busyboxCat: children.busyboxCat,
      ripgrep: children.ripgrep,
    });
    await writeExclusive(NodePath.join(outputDir, "child-program-sources.json"), sourceBundle);
    written.push({
      path: "child-program-sources.json",
      bytes: sourceBundle.byteLength,
      sha256: digest(sourceBundle),
    });

    const inventory = jsonBytes(children.sourceInventory);
    await writeExclusive(NodePath.join(outputDir, "source-inventory.json"), inventory);
    written.push({
      path: "source-inventory.json",
      bytes: inventory.byteLength,
      sha256: digest(inventory),
    });

    const sourceAfter = await sourceRecords(frozenSourcePaths);
    if (!sameRecords(sourceBefore, sourceAfter)) {
      throw new Error("Computer policy fixture sources changed while the fixture was written");
    }

    const sourceCommit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: WORKTREE_ROOT,
      encoding: "utf8",
    }).trim();
    const sourceBranch = NodeChildProcess.execFileSync("git", ["branch", "--show-current"], {
      cwd: WORKTREE_ROOT,
      encoding: "utf8",
    }).trim();
    const manifest = {
      format: "signalbox-computer-policy-proof-fixture-v1",
      sourceCommit,
      sourceBranch,
      sourceHashes: sourceBefore,
      sourceInventory: children.sourceInventory,
      programInputDirectory: programDir,
      policy: { isolateExecutables: COMPUTER_ISOLATE_EXECUTABLES, default: "machine" },
      outputs: written.sort((left, right) => left.path.localeCompare(right.path)),
      machinePort: "forwarding-capture-only",
      vmProof: false,
      noOverwrite: true,
    };
    const manifestBytes = jsonBytes(manifest);
    await writeExclusive(NodePath.join(outputDir, "manifest.json"), manifestBytes);
    const receipt = {
      status: "prepared",
      manifestSha256: digest(manifestBytes),
      sourceCommit,
      sourceBranch,
      sourceFileCount: sourceBefore.length,
      outputFileCount: written.length,
      machinePort: "forwarding-capture-only",
      vmProof: false,
      noOverwrite: true,
    };
    await writeExclusive(NodePath.join(outputDir, "receipt.json"), jsonBytes(receipt));
    return { outputDir, ...receipt };
  } catch (error) {
    const failure = {
      status: "failed",
      error: String(error),
      written: [...written].sort((left, right) => left.path.localeCompare(right.path)),
      noOverwrite: true,
    };
    await writeExclusive(
      NodePath.join(outputDir, "failure.receipt.json"),
      jsonBytes(failure),
    ).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] === import.meta.filename) {
  const { values } = NodeUtil.parseArgs({
    allowPositionals: false,
    options: {
      programs: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    NodeProcess.stdout.write(
      "Usage: node --experimental-strip-types infra/computerPolicyProof/prepare.mjs --programs <dir> --output <fresh .t3 dir>\n",
    );
  } else {
    const result = await prepareComputerPolicyFixture({
      programsPath: values.programs,
      outputPath: values.output,
    });
    NodeProcess.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
