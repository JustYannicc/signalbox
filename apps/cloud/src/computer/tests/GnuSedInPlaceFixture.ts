// @effect-diagnostics nodeBuiltinImport:off - native-only fixture using synthetic files and a pinned local WASM artifact.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { childBusyboxFixture } from "./ChildBusyboxFixture.ts";

function executableOnPath(name: string): string | undefined {
  for (const directory of (NodeProcess.env.PATH ?? "").split(NodePath.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = NodePath.join(directory, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the caller's PATH.
    }
  }
  return undefined;
}

export const GNU_SED =
  NodeProcess.env.SIGNALBOX_GNU_SED ??
  (NodeProcess.platform === "darwin" && NodeFS.existsSync("/opt/homebrew/bin/gsed")
    ? "/opt/homebrew/bin/gsed"
    : undefined) ??
  executableOnPath("gsed") ??
  executableOnPath("sed") ??
  "sed";

export interface SedInputFile {
  readonly name: string;
  readonly before: string;
  readonly after: string;
  readonly mode: number;
}

export interface SedInPlaceCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly files: readonly SedInputFile[];
  readonly backupSuffix?: string;
}

export const sedInPlaceCases: readonly SedInPlaceCase[] = [
  {
    name: "bare -i, one file without a trailing newline",
    args: ["-i", "s/needle/thread/g", "plain.txt"],
    files: [
      {
        name: "plain.txt",
        before: "needle needle\nno-final-newline",
        after: "thread thread\nno-final-newline",
        mode: 0o640,
      },
    ],
  },
  {
    name: "-i.bak, one executable-mode file",
    args: ["-i.bak", "s/needle/thread/g", "backup.txt"],
    backupSuffix: ".bak",
    files: [
      {
        name: "backup.txt",
        before: "needle\nmode 755",
        after: "thread\nmode 755",
        mode: 0o755,
      },
    ],
  },
  {
    name: "-i.bak across two files",
    args: ["-i.bak", "s/needle/thread/g", "first-backup.txt", "second-backup.txt"],
    backupSuffix: ".bak",
    files: [
      {
        name: "first-backup.txt",
        before: "needle first\nlast needle",
        after: "thread first\nlast thread",
        mode: 0o640,
      },
      {
        name: "second-backup.txt",
        before: "needle second\n",
        after: "thread second\n",
        mode: 0o755,
      },
    ],
  },
  {
    name: "multiple -e scripts across two files",
    args: ["-i", "-e", "s/needle/thread/g", "-e", "s/other/second/g", "first.txt", "second.txt"],
    files: [
      {
        name: "first.txt",
        before: "needle other\nlast needle",
        after: "thread second\nlast thread",
        mode: 0o640,
      },
      {
        name: "second.txt",
        before: "other needle\n",
        after: "second thread\n",
        mode: 0o755,
      },
    ],
  },
  {
    name: "-i -E with capture substitution",
    args: ["-i", "-E", "s/(nee)(dle)/\\2\\1/g", "extended.txt"],
    files: [
      {
        name: "extended.txt",
        before: "needle needle\n",
        after: "dlenee dlenee\n",
        mode: 0o640,
      },
    ],
  },
  {
    name: "-i -n 1p across two files",
    args: ["-i", "-n", "1p", "first-line.txt", "second-line.txt"],
    files: [
      {
        name: "first-line.txt",
        before: "first-1\nfirst-2\n",
        after: "first-1\n",
        mode: 0o640,
      },
      {
        name: "second-line.txt",
        before: "second-1\nsecond-2\n",
        after: "second-1\n",
        mode: 0o640,
      },
    ],
  },
  {
    name: "clustered -Ei has no backup suffix",
    args: ["-Ei", "s/(needle)/[\\1]/g", "clustered.txt"],
    files: [
      {
        name: "clustered.txt",
        before: "needle needle\n",
        after: "[needle] [needle]\n",
        mode: 0o640,
      },
    ],
  },
];

export interface DirectoryEntrySnapshot {
  readonly name: string;
  readonly type: string;
  readonly bytes: readonly number[];
  readonly mode: number;
  readonly inode: string;
  readonly linkTarget?: string;
}

export interface DirectorySnapshot {
  readonly entries: readonly DirectoryEntrySnapshot[];
}

export function createNativeDirectory(files: readonly SedInputFile[]): string {
  const base = NodeProcess.env.SIGNALBOX_SED_ARTIFACT_DIR ?? NodeOS.tmpdir();
  const directory = NodeFS.mkdtempSync(NodePath.join(base, "signalbox-sed-gnu-"));
  for (const file of files) {
    const path = NodePath.join(directory, file.name);
    NodeFS.writeFileSync(path, Buffer.from(file.before, "utf8"), { mode: file.mode });
    NodeFS.chmodSync(path, file.mode);
  }
  return directory;
}

export function snapshotNativeDirectory(directory: string): DirectorySnapshot {
  const entries = NodeFS.readdirSync(directory)
    .sort()
    .map((name) => {
      const path = NodePath.join(directory, name);
      const stat = NodeFS.lstatSync(path);
      return {
        name,
        type: stat.isFile()
          ? "file"
          : stat.isDirectory()
            ? "directory"
            : stat.isSymbolicLink()
              ? "symlink"
              : "other",
        bytes: stat.isFile() ? [...NodeFS.readFileSync(path)] : [],
        mode: stat.mode & 0o7777,
        inode: String(stat.ino),
        ...(stat.isSymbolicLink() ? { linkTarget: NodeFS.readlinkSync(path) } : {}),
      };
    });
  return { entries };
}

export function snapshotKernelDirectory(
  fixture: ReturnType<typeof childBusyboxFixture>,
): DirectorySnapshot {
  const entries = fixture.filesystem
    .readdir("/workspace")
    .filter((name) => name !== "nested")
    .sort()
    .map((name) => {
      const path = `/workspace/${name}`;
      const stat = fixture.filesystem.lstat(path);
      return {
        name,
        type: stat.type,
        bytes: stat.type === "file" ? [...readKernelFile(fixture, path)] : [],
        mode: fixture.filesystem.getPosixMetadata(path, false).mode,
        inode: String(stat.ino),
        ...(stat.type === "symlink" ? { linkTarget: fixture.filesystem.readlink(path) } : {}),
      };
    });
  return { entries };
}

export function fileProjection(snapshot: DirectorySnapshot) {
  return snapshot.entries.map(({ name, type, bytes, mode, linkTarget }) => ({
    name,
    type,
    bytes,
    mode,
    ...(linkTarget === undefined ? {} : { linkTarget }),
  }));
}

export function inodeAt(snapshot: DirectorySnapshot, name: string): string | undefined {
  return snapshot.entries.find((entry) => entry.name === name)?.inode;
}

export function expectedDirectory(case_: SedInPlaceCase): DirectoryEntrySnapshot[] {
  const expected: DirectoryEntrySnapshot[] = case_.files.map((file) => ({
    name: file.name,
    type: "file",
    bytes: [...Buffer.from(file.after, "utf8")],
    mode: file.mode,
    inode: "",
  }));
  if (case_.backupSuffix !== undefined) {
    for (const file of case_.files) {
      expected.push({
        name: `${file.name}${case_.backupSuffix}`,
        type: "file",
        bytes: [...Buffer.from(file.before, "utf8")],
        mode: file.mode,
        inode: "",
      });
    }
  }
  return expected
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ inode: _inode, ...entry }) => ({ ...entry, inode: "" }));
}

export function ensureGnuSed(): string {
  const result = NodeChildProcess.spawnSync(GNU_SED, ["--version"], {
    argv0: "sed",
    env: { ...NodeProcess.env, LC_ALL: "C" },
  });
  const version = result.stdout.toString("utf8").split("\n", 1)[0];
  if (result.status !== 0 || !version?.startsWith("sed (GNU sed) ")) {
    throw new Error(`Expected GNU sed; observed ${version ?? result.stderr.toString("utf8")}`);
  }
  return version;
}

export function runGnuSed(args: readonly string[], cwd: string) {
  return NodeChildProcess.spawnSync(GNU_SED, [...args], {
    cwd,
    argv0: "sed",
    env: { ...NodeProcess.env, LC_ALL: "C" },
  });
}

export function runGnuSedWithRenameDenied(
  args: readonly string[],
  cwd: string,
  destination: string,
) {
  if (NodeProcess.platform !== "darwin") {
    throw new Error("The GNU rename-failure fixture requires macOS sandbox-exec");
  }
  const realDestination = NodeFS.realpathSync(destination);
  const profile = `(version 1) (allow default) (deny file-write* (literal "${realDestination}"))`;
  return NodeChildProcess.spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, "/bin/sh", "-c", 'exec -a sed "$@"', "sh", GNU_SED, ...args],
    { cwd, env: { ...NodeProcess.env, LC_ALL: "C" } },
  );
}

export function decodeGuestPath(
  request: {
    readonly args: readonly (number | bigint)[];
    readonly regions: readonly { readonly pointer: number; readonly bytes: Uint8Array }[];
  },
  pointerIndex: number,
  lengthIndex: number,
): string {
  const pointer = Number(request.args[pointerIndex]);
  const length = Number(request.args[lengthIndex]);
  const region = request.regions.find(
    (candidate) =>
      pointer >= candidate.pointer &&
      pointer + length <= candidate.pointer + candidate.bytes.length,
  );
  if (region === undefined)
    throw new Error("WASI path bytes were not present in the syscall request");
  return new TextDecoder().decode(
    region.bytes.subarray(pointer - region.pointer, pointer - region.pointer + length),
  );
}

export function readKernelFile(
  fixture: ReturnType<typeof childBusyboxFixture>,
  path: string,
): Uint8Array {
  const fd = fixture.filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const bytes = new Uint8Array(Number(fixture.filesystem.fstat(fd).size));
    const count = fixture.filesystem.read(fd, bytes, null);
    return bytes.subarray(0, count).slice();
  } finally {
    fixture.filesystem.close(fd);
  }
}

export function kernelPreopenPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
