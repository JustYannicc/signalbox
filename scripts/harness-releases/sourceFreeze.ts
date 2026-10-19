import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { record, sha256 } from "./guards.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// Release metadata is input data. Every executable build, host and proof input stays frozen.
const roots = [
  "scripts/harness-releases",
  "scripts/claude-bunfs",
  "native/codex-wasm",
  "native/kernel-programs",
  "apps/cloud/src",
  "apps/cloud/infra",
  "packages/automations/src",
  "packages/contracts/src",
  "packages/runner-protocol/src",
  "packages/provider-core/src",
  "packages/shared/src",
  ".github/workflows",
  "package.json",
  "apps/cloud/package.json",
  "scripts/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "patches",
  "scripts/lib",
];

export interface SourceFreeze {
  readonly commit: string;
  readonly sha256: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly executable: boolean;
    readonly bytes: number;
    readonly sha256: string;
  }>;
}

/** Includes uncommitted and untracked source, so an uncommitted release workaround still fails. */
export async function freezeSources(repository: string): Promise<SourceFreeze> {
  const git = (args: string[]) => execFile("git", args, { cwd: repository, maxBuffer: 32 << 20 });
  const { stdout: commit } = await git(["rev-parse", "HEAD"]);
  const { stdout: names } = await git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...roots,
  ]);
  const files = [];
  for (const path of [...new Set(names.split("\0").filter(Boolean))].sort()) {
    const absolute = NodePath.join(repository, path);
    const stat = await NodeFSP.lstat(absolute);
    // A symlink's target can change outside this checkout without changing the source digest.
    if (!stat.isFile()) throw new Error(`RELEASE_SOURCE_NOT_REGULAR: ${path}`);
    const bytes = await NodeFSP.readFile(absolute);
    files.push({
      path,
      executable: !!(stat.mode & 0o111),
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  if (!files.length) throw new Error("RELEASE_SOURCE_EMPTY");
  return { commit: commit.trim(), sha256: sha256(JSON.stringify(files)), files };
}

export function assertSourcesUnchanged(before: SourceFreeze, after: SourceFreeze) {
  if (before.commit !== after.commit || before.sha256 !== after.sha256)
    throw new Error("RELEASE_SOURCE_CHANGED: per-release edits are forbidden");
}

/** Read the same source-freeze contract produced by freezeSources. */
export function readSourceFreeze(value: unknown): SourceFreeze {
  const input = record(value, "RELEASE_SOURCE_FREEZE_INVALID");
  const commit = input.commit;
  const hash = input.sha256;
  if (
    typeof commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(commit) ||
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(hash) ||
    !Array.isArray(input.files) ||
    input.files.length === 0
  )
    throw new Error("RELEASE_SOURCE_FREEZE_INVALID");
  const files = input.files.map((value) => {
    const file = record(value, "RELEASE_SOURCE_FREEZE_INVALID");
    if (
      typeof file.path !== "string" ||
      !file.path ||
      typeof file.executable !== "boolean" ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("RELEASE_SOURCE_FREEZE_INVALID");
    return {
      path: file.path,
      executable: file.executable,
      bytes: file.bytes as number,
      sha256: file.sha256,
    };
  });
  if (sha256(JSON.stringify(files)) !== hash) throw new Error("RELEASE_SOURCE_FREEZE_INVALID");
  return { commit, sha256: hash, files };
}
