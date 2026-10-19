import { describe, expect, it } from "vite-plus/test";
import type { ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";
import { createMemoryFilePersistencePorts } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import type { MachineHandle } from "../../src/computer/Machine.ts";
import {
  BoxdProofWorkspaceError,
  createBoxdProofWorkspaceResume,
  type BoxdProofTrackedFile,
  type BoxdProofVmPort,
} from "./Workspace.ts";

const before: ForkCommit = { repository: "repo", fork: "proof", commit: "before-1" };
const machine: MachineHandle = { id: "proof-machine", generation: 7, release: async () => {} };
const tracked: BoxdProofTrackedFile = {
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

interface NativeFile {
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

class ResumeVm implements BoxdProofVmPort {
  readonly scripts: string[] = [];
  readonly uploads: string[] = [];
  readonly downloads: string[] = [];
  readonly files = new Map<string, NativeFile>();

  async exec(
    _machineId: string,
    argv: readonly string[],
    cwd: string | undefined,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const script = argv[1] ?? "";
    this.scripts.push(script);
    if (script.includes("BOXD_PROOF:prepare") || script.includes("BOXD_PROOF:finalize")) {
      return { exitCode: 1, stdout: "", stderr: "resume must never mutate the workspace" };
    }
    if (cwd !== "/workspace") return { exitCode: 1, stdout: "", stderr: "bad cwd" };
    if (script.includes("BOXD_PROOF:scan")) {
      const entries = [...this.files].map(([path, file]) => ({
        path,
        type: file.type,
        size: String(file.bytes.byteLength),
        nlink: String(file.nlink),
        atimeNs: file.atimeNs,
        mtimeNs: file.mtimeNs,
        ctimeNs: file.ctimeNs,
        mode: file.mode,
        uid: file.uid,
        gid: file.gid,
      }));
      return { exitCode: 0, stdout: JSON.stringify({ entries }), stderr: "" };
    }
    if (script.includes("BOXD_PROOF:canonical-cwd")) {
      return { exitCode: 0, stdout: JSON.stringify({ cwd: argv[2] }), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected resume probe" };
  }

  async upload(_machineId: string, path: string) {
    this.uploads.push(path);
    throw new Error("resume attempted an upload");
  }

  async download(_machineId: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.downloads.push(path);
    if (path !== "/workspace/out.bin") throw new Error("unexpected download path");
    const file = this.files.get("out.bin");
    if (!file) throw new Error("proof file is unavailable");
    return file.bytes.slice();
  }
}

function existingVm() {
  const vm = new ResumeVm();
  vm.files.set("out.bin", {
    type: "file",
    bytes: new Uint8Array([8, 0, 255]),
    mode: 0o700,
    uid: 1001,
    gid: 1002,
    nlink: 1,
    atimeNs: "20",
    mtimeNs: "23",
    ctimeNs: "24",
  });
  return vm;
}

describe("boxd proof workspace resume", () => {
  it("reattaches to existing bytes and returns the exact frozen owner snapshot", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(before, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = existingVm();
    const resume = createBoxdProofWorkspaceResume({
      vm,
      trackedFiles: [tracked],
      hydration: persistence.hydration,
    });

    const result = await resume({
      operationId: "operation-1",
      machine,
      before,
      signal: new AbortController().signal,
    });

    expect(result.ownership).toMatchObject({
      operationId: "operation-1",
      machineId: machine.id,
      generation: machine.generation,
      before,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ownership)).toBe(true);
    expect(Object.isFrozen(result.ownership.before)).toBe(true);
    expect(result.ownership.before).not.toBe(before);
    expect(vm.downloads).toEqual(["/workspace/out.bin"]);
    expect(vm.uploads).toEqual([]);
    expect(vm.scripts.some((script) => script.includes("BOXD_PROOF:prepare"))).toBe(false);
    expect(vm.scripts.some((script) => script.includes("BOXD_PROOF:finalize"))).toBe(false);

    const changes = await result.mount.changes(new AbortController().signal);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      inode: 91n,
      paths: ["/out.bin"],
      stat: { type: "file", size: 3n, mtimeNs: 23n, ctimeNs: 24n },
      posix: { mode: 0o700, uid: 1001, gid: 1002 },
    });
    expect(await collect(changes[0]!.readChunks())).toEqual(new Uint8Array([8, 0, 255]));
    expect(vm.uploads).toEqual([]);
    expect(vm.scripts.some((script) => script.includes("BOXD_PROOF:prepare"))).toBe(false);
    expect(vm.scripts.some((script) => script.includes("BOXD_PROOF:finalize"))).toBe(false);
  });

  it("rejects invalid ownership and manifests without writing to the VM", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(before, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = existingVm();
    const resume = createBoxdProofWorkspaceResume({
      vm,
      trackedFiles: [tracked],
      hydration: persistence.hydration,
    });

    await expect(
      resume({
        operationId: "operation-1",
        machine: { ...machine, generation: 0 },
        before,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(BoxdProofWorkspaceError);
    expect(() =>
      createBoxdProofWorkspaceResume({
        vm,
        trackedFiles: [{ ...tracked, path: "/other.bin" }],
        hydration: persistence.hydration,
      }),
    ).toThrow(/another manifest shape/);

    const mismatchedBaseline = createMemoryFilePersistencePorts();
    mismatchedBaseline.seedFile(before, "/out.bin", new Uint8Array([0, 255, 1]));
    const resumeWithMismatch = createBoxdProofWorkspaceResume({
      vm,
      trackedFiles: [tracked],
      hydration: mismatchedBaseline.hydration,
    });
    await expect(
      resumeWithMismatch({
        operationId: "operation-1",
        machine,
        before,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/do not match the tracked kernel file size/);

    expect(vm.uploads).toEqual([]);
    expect(vm.scripts).toEqual([]);
  });

  it("fails on missing or untracked VM files without attempting recovery writes", async () => {
    const persistence = createMemoryFilePersistencePorts();
    persistence.seedFile(before, "/out.bin", new Uint8Array([0, 255, 1, 2]));
    const vm = existingVm();
    const resume = createBoxdProofWorkspaceResume({
      vm,
      trackedFiles: [tracked],
      hydration: persistence.hydration,
    });

    vm.files.delete("out.bin");
    await expect(
      resume({
        operationId: "operation-1",
        machine,
        before,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/missing/);

    vm.files.set("out.bin", {
      type: "file",
      bytes: new Uint8Array([0, 255, 1, 2]),
      mode: 0o750,
      uid: 1000,
      gid: 1000,
      nlink: 1,
      atimeNs: "10",
      mtimeNs: "11",
      ctimeNs: "12",
    });
    vm.files.set("extra.bin", {
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
    await expect(
      resume({
        operationId: "operation-1",
        machine,
        before,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/untracked/);

    expect(vm.uploads).toEqual([]);
    expect(vm.scripts.some((script) => script.includes("BOXD_PROOF:prepare"))).toBe(false);
    expect(vm.scripts.some((script) => script.includes("BOXD_PROOF:finalize"))).toBe(false);
  });
});

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of chunks) parts.push(part);
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}
