import {
  BOXD_PROOF_MAX_FILE_BYTES,
  BOXD_PROOF_TRACKED_SCAN_PATH,
  BOXD_PROOF_TRACKED_VM_PATH,
  BOXD_PROOF_WORKSPACE_ROOT,
  BoxdProofWorkspaceError,
  type BoxdProofNativeFileMetadata,
  type BoxdProofNativeResumeBaseline,
  type BoxdProofNativeScan,
  type BoxdProofNativeWorkspace,
  type BoxdProofVmPort,
} from "./WorkspaceTypes.ts";
import { BOXD_PROOF_WORKSPACE_FINALIZE } from "./NativeInstall.ts";

const PREPARE_SCRIPT = String.raw`# BOXD_PROOF:prepare
import os, stat, sys
root = "/workspace"
try:
    os.mkdir(root, 0o755)
except FileExistsError:
    pass
root_stat = os.lstat(root)
if not stat.S_ISDIR(root_stat.st_mode) or os.path.realpath(root) != root:
    raise RuntimeError("proof workspace must be the real /workspace directory")
with os.scandir(root) as entries:
    if next(entries, None) is not None:
        raise RuntimeError("proof workspace must be empty before hydration")
staging = sys.argv[1]
if (
    os.path.dirname(staging) != "/tmp"
    or not os.path.basename(staging).startswith(".signalbox-boxd-proof-")
    or os.path.realpath(staging) != staging
):
    raise RuntimeError("hydration staging path is outside the owned /tmp namespace")
if os.path.lexists(staging):
    raise RuntimeError("hydration staging path already exists")
`;

const SCAN_SCRIPT = String.raw`# BOXD_PROOF:scan
import json, os, stat
root = "/workspace"
if os.path.realpath(root) != root or not stat.S_ISDIR(os.lstat(root).st_mode):
    raise RuntimeError("proof workspace is not canonical")
entries = []
def walk(directory, prefix):
    with os.scandir(directory) as children:
        for child in children:
            relative = child.name if not prefix else prefix + "/" + child.name
            value = child.stat(follow_symlinks=False)
            if stat.S_ISREG(value.st_mode):
                kind = "file"
            elif stat.S_ISDIR(value.st_mode):
                kind = "directory"
            elif stat.S_ISLNK(value.st_mode):
                kind = "symlink"
            else:
                kind = "other"
            entries.append({
                "path": relative,
                "type": kind,
                "size": str(value.st_size),
                "nlink": str(value.st_nlink),
                "atimeNs": str(value.st_atime_ns),
                "mtimeNs": str(value.st_mtime_ns),
                "ctimeNs": str(value.st_ctime_ns),
                "mode": stat.S_IMODE(value.st_mode),
                "uid": value.st_uid,
                "gid": value.st_gid,
            })
            if kind == "directory":
                walk(child.path, relative)
walk(root, "")
print(json.dumps({"entries": entries}, separators=(",", ":")))
`;

const CANONICAL_CWD_SCRIPT = String.raw`# BOXD_PROOF:canonical-cwd
import json, os, stat, sys
root = "/workspace"
requested = sys.argv[1]
if os.path.realpath(root) != root or not stat.S_ISDIR(os.lstat(root).st_mode):
    raise RuntimeError("proof workspace is not canonical")
if not os.path.isabs(requested):
    raise RuntimeError("command cwd must be absolute")
normalized = os.path.normpath(requested)
if normalized != root and not normalized.startswith(root + "/"):
    raise RuntimeError("command cwd escapes proof workspace")
if os.path.realpath(normalized) != normalized or not os.path.isdir(normalized):
    raise RuntimeError("command cwd must be an existing real directory")
print(json.dumps({"cwd": requested}, separators=(",", ":")))
`;

export async function prepareBoxdProofNativeWorkspace(
  vm: BoxdProofVmPort,
  machineId: string,
  initialBytes: Uint8Array,
  metadata: {
    readonly mode: number;
    readonly uid: number | null;
    readonly gid: number | null;
    readonly atimeNs: bigint;
    readonly mtimeNs: bigint;
  },
  signal: AbortSignal,
): Promise<BoxdProofNativeWorkspace> {
  const stagingPath = stagingPathFor(machineId);
  await runPython(vm, machineId, PREPARE_SCRIPT, stagingPath, "/", signal, "prepare");
  await vm.upload(machineId, stagingPath, initialBytes.slice(), signal);
  signal.throwIfAborted();

  await runPython(
    vm,
    machineId,
    BOXD_PROOF_WORKSPACE_FINALIZE,
    JSON.stringify({
      stagingPath,
      size: initialBytes.byteLength,
      mode: metadata.mode,
      uid: metadata.uid,
      gid: metadata.gid,
      atimeNs: metadata.atimeNs.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
    }),
    BOXD_PROOF_WORKSPACE_ROOT,
    signal,
    "finalize hydration",
  );
  const baseline = await readTrackedNativeFile(vm, machineId, signal, "record baseline");
  assertFileSize(baseline, initialBytes.byteLength, "hydrated proof file");

  return createNativeWorkspace(vm, machineId, initialBytes, baseline, sameNativeMetadata);
}

/** Reopens the existing workspace without preparing, finalizing, or uploading any bytes. */
export async function resumeBoxdProofNativeWorkspace(
  vm: BoxdProofVmPort,
  machineId: string,
  beforeBytes: Uint8Array,
  beforeMetadata: BoxdProofNativeResumeBaseline,
  signal: AbortSignal,
): Promise<BoxdProofNativeWorkspace> {
  const current = await readTrackedNativeFile(vm, machineId, signal, "validate resumed workspace");
  const currentBytes = Uint8Array.from(
    await vm.download(machineId, BOXD_PROOF_TRACKED_VM_PATH, signal),
  );
  signal.throwIfAborted();
  assertFileSize(current, currentBytes.byteLength, "resumed proof file");

  return createNativeWorkspace(vm, machineId, beforeBytes, beforeMetadata, sameResumedMetadata);
}

function createNativeWorkspace<
  TBaseline extends BoxdProofNativeFileMetadata | BoxdProofNativeResumeBaseline,
>(
  vm: BoxdProofVmPort,
  machineId: string,
  baselineBytes: Uint8Array,
  baselineMetadata: TBaseline,
  sameMetadata: (left: BoxdProofNativeFileMetadata, right: TBaseline) => boolean,
): BoxdProofNativeWorkspace {
  return Object.freeze({
    async validateCwd(requested: string, cwdSignal: AbortSignal) {
      await runPython(
        vm,
        machineId,
        CANONICAL_CWD_SCRIPT,
        requested,
        BOXD_PROOF_WORKSPACE_ROOT,
        cwdSignal,
        "validate command cwd",
      );
    },
    async readChanges(changesSignal: AbortSignal) {
      changesSignal.throwIfAborted();
      const current = await readTrackedNativeFile(
        vm,
        machineId,
        changesSignal,
        "read post-command metadata",
      );
      const bytes = vm.download(machineId, BOXD_PROOF_TRACKED_VM_PATH, changesSignal);
      const detachedBytes = Uint8Array.from(await bytes);
      changesSignal.throwIfAborted();
      assertFileSize(current, detachedBytes.byteLength, "post-command proof file");

      if (sameBytes(baselineBytes, detachedBytes) && sameMetadata(current, baselineMetadata)) {
        return undefined;
      }

      return Object.freeze({ metadata: current, bytes: detachedBytes });
    },
  });
}

async function readTrackedNativeFile(
  vm: BoxdProofVmPort,
  machineId: string,
  signal: AbortSignal,
  phase: string,
): Promise<BoxdProofNativeFileMetadata> {
  const stdout = await runPython(
    vm,
    machineId,
    SCAN_SCRIPT,
    undefined,
    BOXD_PROOF_WORKSPACE_ROOT,
    signal,
    phase,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (error) {
    throw new BoxdProofWorkspaceError(`The native ${phase} probe returned invalid JSON`, {
      cause: error,
    });
  }
  if (!isNativeScan(decoded)) {
    throw new BoxdProofWorkspaceError(`The native ${phase} probe returned invalid metadata`);
  }
  if (decoded.entries.length === 0) {
    throw new BoxdProofWorkspaceError("The tracked proof file is missing from the VM workspace");
  }
  if (decoded.entries.length !== 1) {
    const extra = decoded.entries.find((entry) => entry.path !== BOXD_PROOF_TRACKED_SCAN_PATH);
    if (extra?.type === "symlink") {
      throw new BoxdProofWorkspaceError(`Symlink is outside the proof manifest: ${extra.path}`);
    }
    throw new BoxdProofWorkspaceError("The VM namespace contains an untracked proof entry");
  }
  const file = decoded.entries[0]!;
  if (file.path !== BOXD_PROOF_TRACKED_SCAN_PATH) {
    throw new BoxdProofWorkspaceError(`Unexpected VM path outside ${BOXD_PROOF_TRACKED_VM_PATH}`);
  }
  if (file.type === "symlink") {
    throw new BoxdProofWorkspaceError("The tracked proof file became a symlink");
  }
  if (file.type !== "file") {
    throw new BoxdProofWorkspaceError("The tracked proof path is missing or is not a regular file");
  }
  if (BigInt(file.nlink) !== 1n) {
    throw new BoxdProofWorkspaceError(
      "The proof file has a link outside the supported fixture shape",
    );
  }
  if (BigInt(file.size) > BigInt(BOXD_PROOF_MAX_FILE_BYTES)) {
    throw new BoxdProofWorkspaceError(
      "The post-command proof file exceeds the 16 MiB fixture limit",
    );
  }
  return file;
}

async function runPython(
  vm: BoxdProofVmPort,
  machineId: string,
  script: string,
  argument: string | undefined,
  cwd: string,
  signal: AbortSignal,
  phase: string,
): Promise<string> {
  signal.throwIfAborted();
  const argv = ["-c", script];
  if (argument !== undefined) argv.push(argument);
  const result = await vm.exec(machineId, argv, cwd, signal);
  signal.throwIfAborted();
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new BoxdProofWorkspaceError(
      `Native ${phase} failed${detail ? `: ${detail}` : ` with exit ${result.exitCode}`}`,
    );
  }
  return result.stdout;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function stagingPathFor(machineId: string): string {
  return `/tmp/.signalbox-boxd-proof-${encodeURIComponent(machineId)}.upload`;
}

function sameNativeMetadata(
  left: BoxdProofNativeFileMetadata,
  right: BoxdProofNativeFileMetadata,
): boolean {
  return (
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameResumedMetadata(
  current: BoxdProofNativeFileMetadata,
  baseline: BoxdProofNativeResumeBaseline,
): boolean {
  return (
    current.size === baseline.size &&
    current.nlink === baseline.nlink &&
    current.mtimeNs === baseline.mtimeNs &&
    current.mode === baseline.mode &&
    (baseline.uid === null || current.uid === baseline.uid) &&
    (baseline.gid === null || current.gid === baseline.gid)
  );
}

function assertFileSize(file: BoxdProofNativeFileMetadata, size: number, label: string): void {
  if (BigInt(file.size) !== BigInt(size)) {
    throw new BoxdProofWorkspaceError(`The ${label} size does not match its native stat`);
  }
}

function isNativeScan(value: unknown): value is BoxdProofNativeScan {
  if (!isRecord(value) || !Array.isArray(value.entries)) return false;
  return value.entries.every(isNativeFileMetadata);
}

function isNativeFileMetadata(value: unknown): value is BoxdProofNativeFileMetadata {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    (value.type === "file" ||
      value.type === "directory" ||
      value.type === "symlink" ||
      value.type === "other") &&
    isIntegerString(value.size) &&
    isIntegerString(value.nlink) &&
    isIntegerString(value.atimeNs) &&
    isIntegerString(value.mtimeNs) &&
    isIntegerString(value.ctimeNs) &&
    isSafeIntegerInRange(value.mode, 0, 0o7777) &&
    isSafeIntegerInRange(value.uid, 0, 0xffff_ffff - 1) &&
    isSafeIntegerInRange(value.gid, 0, 0xffff_ffff - 1)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
