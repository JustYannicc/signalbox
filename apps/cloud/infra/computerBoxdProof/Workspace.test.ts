import { describe, expect, it } from "vite-plus/test";
import type { ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";
import { createMemoryFilePersistencePorts } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import type { MachineHandle } from "../../src/computer/Machine.ts";
import type { KernelCommand } from "../../src/kernel/KernelCommandForwarder.ts";
import {
  BoxdProofWorkspaceError,
  createBoxdProofWorkspace,
  type BoxdProofTrackedFile,
  type BoxdProofVmPort,
} from "./Workspace.ts";

const base: ForkCommit = { repository: "repo", fork: "proof", commit: "base-1" };
const machine: MachineHandle = { id: "proof-machine", generation: 7, release: async () => {} };
const kernelFile: BoxdProofTrackedFile = {
  path: "/out.bin",
  inode: 91n,
  stat: {
    type: "file",
    size: 4n,
    nlink: 1n,
    atimeNs: 10n,
    mtimeNs: 11n,
    ctimeNs: 12n,
  },
  posix: { mode: 0o750, uid: 1000, gid: 1000 },
};

interface FakeFile {
  readonly type: "file";
  bytes: Uint8Array;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  atimeNs: string;
  mtimeNs: string;
  ctimeNs: string;
}

interface FakeSymlink {
  readonly type: "symlink";
  readonly target: string;
}

type FakeEntry = FakeFile | FakeSymlink;

class FakeVm implements BoxdProofVmPort {
  readonly entries = new Map<string, FakeEntry>();
  readonly stagedUploads = new Map<string, FakeFile>();
  readonly uploadPaths: string[] = [];
  refuseProtectedUploads = false;
  rootKind: "directory" | "symlink" = "directory";
  private rootExists = false;
  private clock = 20n;

  async exec(
    _machineId: string,
    argv: readonly string[],
    cwd: string | undefined,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (argv[0] !== "-c") return failed("unsupported probe command");
    const script = argv[1] ?? "";
    if (script.includes("BOXD_PROOF:prepare")) {
      if (cwd !== "/") return failed("prepare must start at /");
      if (this.rootKind === "symlink")
        return failed("proof workspace must be the real /workspace directory");
      if (this.rootExists && this.entries.size > 0)
        return failed("proof workspace must be empty before hydration");
      this.rootExists = true;
      return ok("");
    }
    if (!this.rootExists || this.rootKind !== "directory")
      return failed("proof workspace is not canonical");
    if (cwd !== "/workspace") return failed("probe must use canonical /workspace");

    if (script.includes("BOXD_PROOF:finalize")) {
      const metadata = JSON.parse(argv[2] ?? "{}") as {
        readonly stagingPath?: string;
        readonly mode: number;
        readonly atimeNs: string;
        readonly mtimeNs: string;
        readonly uid?: number;
        readonly gid?: number;
      };
      let file: FakeFile | undefined;
      if (metadata.stagingPath !== undefined) {
        file = this.stagedUploads.get(metadata.stagingPath);
        if (!file) return failed("staged proof file is missing");
        this.stagedUploads.delete(metadata.stagingPath);
        file = { ...file };
        this.entries.set("out.bin", file);
      } else {
        const direct = this.entries.get("out.bin");
        if (direct?.type === "file") file = direct;
      }
      if (!file) return failed("hydrated proof file is not a regular file");
      file.mode = metadata.mode & 0o777;
      file.uid = metadata.uid ?? file.uid;
      file.gid = metadata.gid ?? file.gid;
      file.atimeNs = metadata.atimeNs;
      file.mtimeNs = metadata.mtimeNs;
      file.ctimeNs = this.tick();
      return ok("");
    }
    if (script.includes("BOXD_PROOF:scan")) {
      const entries = [...this.entries].map(([path, entry]) =>
        entry.type === "file"
          ? {
              path,
              type: "file",
              size: String(entry.bytes.byteLength),
              nlink: String(entry.nlink),
              atimeNs: entry.atimeNs,
              mtimeNs: entry.mtimeNs,
              ctimeNs: entry.ctimeNs,
              mode: entry.mode,
              uid: entry.uid,
              gid: entry.gid,
            }
          : {
              path,
              type: "symlink",
              size: "0",
              nlink: "1",
              atimeNs: "0",
              mtimeNs: "0",
              ctimeNs: "0",
              mode: 0o777,
              uid: 1000,
              gid: 1000,
            },
      );
      return ok(JSON.stringify({ entries }));
    }
    if (script.includes("BOXD_PROOF:canonical-cwd")) {
      const requested = argv[2] ?? "";
      const normalized = normalize(requested);
      if (
        !requested.startsWith("/") ||
        (normalized !== "/workspace" && !normalized.startsWith("/workspace/"))
      ) {
        return failed("command cwd escapes proof workspace");
      }
      if (normalized.startsWith("/workspace/link"))
        return failed("command cwd must be an existing real directory");
      if (normalized !== "/workspace")
        return failed("command cwd must be an existing real directory");
      return ok(JSON.stringify({ cwd: requested }));
    }
    return failed("unknown proof probe");
  }

  async upload(_machineId: string, path: string, bytes: Uint8Array, signal: AbortSignal) {
    signal.throwIfAborted();
    this.uploadPaths.push(path);
    if (!this.rootExists || this.rootKind !== "directory") {
      throw new Error("unexpected upload before workspace preparation");
    }
    if (path.startsWith("/workspace/") && this.refuseProtectedUploads) {
      throw new Error("SDK refuses uploads inside the protected workspace");
    }
    if (path.startsWith("/tmp/.signalbox-boxd-proof-")) {
      this.stagedUploads.set(path, {
        type: "file",
        bytes: bytes.slice(),
        mode: 0o600,
        uid: 2000,
        gid: 2001,
        nlink: 1,
        atimeNs: "0",
        mtimeNs: "0",
        ctimeNs: this.tick(),
      });
      return;
    }
    if (path !== "/workspace/out.bin") {
      throw new Error("unexpected upload path");
    }
    this.entries.set("out.bin", {
      type: "file",
      bytes: bytes.slice(),
      mode: 0o666,
      uid: 1000,
      gid: 1000,
      nlink: 1,
      atimeNs: "0",
      mtimeNs: "0",
      ctimeNs: this.tick(),
    });
  }

  async download(_machineId: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (path !== "/workspace/out.bin") throw new Error("unexpected download path");
    const file = this.entries.get("out.bin");
    if (!file || file.type !== "file") throw new Error("proof file is unavailable");
    return file.bytes.slice();
  }

  mutate(bytes: Uint8Array) {
    const file = this.entries.get("out.bin");
    if (!file || file.type !== "file") throw new Error("proof file is unavailable");
    file.bytes = bytes.slice();
    file.mtimeNs = String(this.tick());
    file.ctimeNs = String(this.tick());
  }

  addUntrackedFile(path: string) {
    this.entries.set(path, {
      type: "file",
      bytes: new Uint8Array([9]),
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      nlink: 1,
      atimeNs: "0",
      mtimeNs: "0",
      ctimeNs: "0",
    });
  }

  addSymlink(path: string) {
    this.entries.set(path, { type: "symlink", target: "/tmp/outside" });
  }

  private tick() {
    this.clock += 1n;
    return String(this.clock);
  }
}

describe("boxd proof workspace", () => {
  it("hydrates when SDK uploads into the protected workspace are refused", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(base, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = new FakeVm();
    vm.refuseProtectedUploads = true;

    const mount = await createBoxdProofWorkspace({ vm, trackedFiles: [kernelFile] })(
      machine,
      base,
      persistence.hydration,
      new AbortController().signal,
    );

    expect(vm.uploadPaths).toHaveLength(1);
    expect(vm.uploadPaths[0]).toMatch(/^\/tmp\/\.signalbox-boxd-proof-/);
    expect(vm.stagedUploads.size).toBe(0);
    expect(vm.entries.get("out.bin")).toMatchObject({
      bytes: new Uint8Array([0, 255, 1, 2]),
      mode: 0o750,
      uid: 1000,
      gid: 1000,
      atimeNs: "10",
      mtimeNs: "11",
    });

    const command = commandAt("/workspace");
    expect(
      await mount.canonicalCwd(command, machine.generation, new AbortController().signal),
    ).toBe(command.cwd);
  });

  it("hydrates only out.bin with exact bytes and returns the exact canonical cwd", async () => {
    const persistence = createMemoryFilePersistencePorts();
    const original = new Uint8Array([0, 255, 1, 2]);
    persistence.seedFile(base, "/out.bin", original);
    original.fill(0);
    const vm = new FakeVm();
    const prepare = createBoxdProofWorkspace({ vm, trackedFiles: [kernelFile] });
    const mount = await prepare(machine, base, persistence.hydration, new AbortController().signal);

    expect(persistence.fetchCalls).toMatchObject([{ at: base, paths: ["/out.bin"], status: "ok" }]);
    expect(vm.entries.get("out.bin")).toMatchObject({
      bytes: new Uint8Array([0, 255, 1, 2]),
      mode: 0o750,
    });

    const command = commandAt("/workspace/.");
    expect(
      await mount.canonicalCwd(command, machine.generation, new AbortController().signal),
    ).toBe(command.cwd);
  });

  it("exports changed bytes under the original logical inode with detached immutable chunks", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(base, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = new FakeVm();
    const mount = await createBoxdProofWorkspace({ vm, trackedFiles: [kernelFile] })(
      machine,
      base,
      persistence.hydration,
      new AbortController().signal,
    );
    vm.mutate(new Uint8Array([8, 0, 255]));

    const changes = await mount.changes(new AbortController().signal);
    expect(changes).toHaveLength(1);
    expect(Object.isFrozen(changes)).toBe(true);
    expect(Object.isFrozen(changes[0])).toBe(true);
    expect(Object.isFrozen(changes[0]!.paths)).toBe(true);
    expect(Object.isFrozen(changes[0]!.stat)).toBe(true);
    expect(Object.isFrozen(changes[0]!.posix)).toBe(true);
    expect(changes[0]).toMatchObject({
      inode: 91n,
      paths: ["/out.bin"],
      removedPaths: [],
      stat: { type: "file", size: 3n, mtimeNs: 23n, ctimeNs: 24n },
      symlinkTarget: null,
      posix: { mode: 0o750, uid: 1000, gid: 1000 },
    });

    vm.mutate(new Uint8Array([7]));
    const firstRead = await readAll(changes[0]!.readChunks());
    firstRead.fill(4);
    expect(await readAll(changes[0]!.readChunks())).toEqual(new Uint8Array([8, 0, 255]));
  });

  it("fails closed on untracked files, symlinks, and cwd escapes", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(base, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = new FakeVm();
    const mount = await createBoxdProofWorkspace({ vm, trackedFiles: [kernelFile] })(
      machine,
      base,
      persistence.hydration,
      new AbortController().signal,
    );

    vm.entries.delete("out.bin");
    await expect(mount.changes(new AbortController().signal)).rejects.toThrow(/missing/);
    const remount = await createBoxdProofWorkspace({ vm, trackedFiles: [kernelFile] })(
      machine,
      base,
      persistence.hydration,
      new AbortController().signal,
    );
    vm.addUntrackedFile("extra.bin");
    await expect(remount.changes(new AbortController().signal)).rejects.toBeInstanceOf(
      BoxdProofWorkspaceError,
    );
    vm.entries.delete("extra.bin");
    vm.addSymlink("escape");
    await expect(remount.changes(new AbortController().signal)).rejects.toThrow(/Symlink/);
    await expect(
      mount.canonicalCwd(
        commandAt("/workspace/../outside"),
        machine.generation,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/escapes/);
    await expect(
      mount.canonicalCwd(
        commandAt("/workspace/link"),
        machine.generation,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/real directory/);
  });

  it("rejects a symlinked workspace and unsupported manifests", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(base, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = new FakeVm();
    vm.rootKind = "symlink";
    const prepare = createBoxdProofWorkspace({ vm, trackedFiles: [kernelFile] });
    await expect(
      prepare(machine, base, persistence.hydration, new AbortController().signal),
    ).rejects.toThrow(/real \/workspace directory/);

    expect(() =>
      createBoxdProofWorkspace({ vm, trackedFiles: [{ ...kernelFile, path: "/other.bin" }] }),
    ).toThrow(/another manifest shape/);
  });

  it("returns no commit entry when bytes and native commit metadata are unchanged", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(base, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = new FakeVm();
    const mount = await createBoxdProofWorkspace({ vm, trackedFiles: [kernelFile] })(
      machine,
      base,
      persistence.hydration,
      new AbortController().signal,
    );
    expect(await mount.changes(new AbortController().signal)).toEqual([]);
  });
});

function commandAt(cwd: string): KernelCommand {
  return { executable: "/bin/cat", argv: ["/bin/cat", "out.bin"], cwd, env: {} };
}

async function readAll(changes: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of changes) {
    parts.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function normalize(path: string) {
  const pieces: string[] = [];
  for (const piece of path.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") pieces.pop();
    else pieces.push(piece);
  }
  return `/${pieces.join("/")}`;
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" } as const;
}

function failed(stderr: string) {
  return { exitCode: 1, stdout: "", stderr } as const;
}
