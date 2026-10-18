// @effect-diagnostics nodeBuiltinImport:off - explicit pinned-artifact proof; uses only in-memory SQLite.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
  type KernelResult,
} from "../../../src/kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import {
  KERNEL_BASH_ARTIFACT,
  createKernelBashProgram,
} from "../../../src/kernel/KernelBashProgram.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../../src/kernel/KernelBusyboxProgram.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import {
  KernelProcessTable,
  type KernelLaunchedChild,
  type KernelProcessIdentity,
} from "../../../src/kernel/KernelProcessTable.ts";
import { registerKernelBusyboxCat } from "../../../src/kernel/KernelBusyboxPrograms.ts";
import { bashSqliteFixture } from "../bash/bashFixture.ts";

const CREDENTIALS = Object.freeze({
  uid: 1000,
  gid: 1000,
  euid: 1000,
  egid: 1000,
});
const BASH_CREDENTIALS = Object.freeze({
  ...CREDENTIALS,
  umask: 0o022,
  hostname: "kernel-proof",
});
const now = () => 1_800_000_000_000_000_001n;
const decoder = new TextDecoder();

class RecordingProcessTable extends KernelProcessTable {
  readonly pids: number[] = [];

  override spawn(
    parent: KernelHandle<"process"> | undefined,
    launch: (identity: KernelProcessIdentity) => KernelLaunchedChild,
    release: () => void | Promise<void>,
    options: { readonly processGroupId?: number } = {},
  ): KernelResult<{ readonly handle: KernelHandle<"process">; readonly pid: number }> {
    const result = super.spawn(parent, launch, release, options);
    if (result.status === "ok") this.pids.push(result.value.pid);
    return result;
  }
}

/** Prove the supported Bash-to-BusyBox cat handoff. */
export async function proveKernelBusyboxCatProgram() {
  const bashBusybox = await proveBashBusyboxHandoff();
  return { ok: true, bashBusybox };
}

async function proveBashBusyboxHandoff() {
  const bashBytes = await NodeFSP.readFile(
    new URL("../bash/build/bash.async.wasm", import.meta.url),
  );
  const busyboxBytes = await NodeFSP.readFile(new URL("./bin/busybox.wasm", import.meta.url));
  assertArtifact("GNU Bash artifact", bashBytes, KERNEL_BASH_ARTIFACT);
  assertArtifact("Nimbus BusyBox artifact", busyboxBytes, KERNEL_BUSYBOX_ARTIFACT);
  const bash = await WebAssembly.compile(bashBytes);
  const busybox = await WebAssembly.compile(busyboxBytes);

  const database = bashSqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, now);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: CREDENTIALS, umask: 0o022 },
  });
  filesystem.mkdir("/workspace");
  filesystem.mkdir("/bin");
  writeAll(filesystem, "/bin/cat", busyboxBytes, 0o755);

  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const busyboxPrograms = registerKernelBusyboxCat(registry, busybox);
  const processes = new RecordingProcessTable({ wakes });
  const bashManifest = Object.freeze({
    name: "@nimbus/bash",
    version: KERNEL_BASH_ARTIFACT.version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([
      "process.spawn",
      "process.wait",
      "process.signal",
    ] as const),
    entrypoint: `nimbus-bash:${KERNEL_BASH_ARTIFACT.sha256}`,
  });
  if (registry.register(bashManifest).status !== "ok")
    throw new Error("Could not register GNU Bash");
  const programs = new Map(busyboxPrograms);
  programs.set("/bin/bash", {
    manifest: bashManifest,
    implementation: createKernelBashProgram({ module: bash, credentials: { ...BASH_CREDENTIALS } }),
  });
  const host = new KernelProgramHost({ registry, wakes, programs, processes });
  const prepared = host.preparePiped({ filesystem }, { cwd: "/workspace" });
  const stdoutPromise = readStream(prepared.stdout);
  const stderrPromise = readStream(prepared.stderr);
  let handle: KernelHandle<"process"> | undefined;
  let bashPid: number | undefined;

  try {
    const input = prepared.stdin.getWriter();
    try {
      await input.close();
    } finally {
      input.releaseLock();
    }
    const resolved = host.resolve("/bin/bash");
    if (resolved.status !== "ok") throw new Error("GNU Bash did not resolve");
    const spawned = callKernel(host.backend(prepared.prepared), "process.spawn", {
      program: resolved.value,
      args: [
        "/bin/bash",
        "-c",
        "umask 077; echo payload > /workspace/result && cat /workspace/result",
      ],
      env: { PATH: "/bin", PWD: "/workspace" },
    });
    if (spawned.status !== "ok")
      throw new Error(`GNU Bash admission failed: ${JSON.stringify(spawned)}`);
    handle = spawned.value;
    const identity = processes.info(handle);
    if (identity.status !== "ok")
      throw new Error(`GNU Bash PID lookup failed: ${JSON.stringify(identity)}`);
    bashPid = identity.value.pid;
    const result = await host.exitStatus(handle);
    if (result.status !== "ok")
      throw new Error(`GNU Bash execution failed: ${JSON.stringify(result)}`);
    NodeAssert.deepEqual(result.value, { exitCode: 0, signal: 0, coreDumped: false });

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    NodeAssert.equal(stdout.text, "payload\n");
    NodeAssert.equal(stderr.text, "");
    NodeAssert.equal(stdout.eof, true);
    NodeAssert.equal(stderr.eof, true);
    const reaped = host.reap(handle);
    NodeAssert.equal(reaped.status, "ok");
    handle = undefined;

    NodeAssert.equal(readFile(filesystem, "/workspace/result"), "payload\n");
    NodeAssert.deepEqual(filesystem.getPosixMetadata("/workspace/result"), {
      mode: 0o600,
      uid: 1000,
      gid: 1000,
    });
    NodeAssert.equal(filesystem.posixPolicy?.umask, 0o022);
    NodeAssert.equal(processes.pids.length, 2);
    NodeAssert.ok(bashPid !== undefined);
    NodeAssert.equal(processes.pids[0], bashPid);
    NodeAssert.ok(processes.pids[1]! > processes.pids[0]!);
    NodeAssert.equal(host.processes.size, 0);
    NodeAssert.equal(wakes.size, 0);
    return {
      script: "umask 077; echo payload > /workspace/result && cat /workspace/result",
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutEof: stdout.eof,
      stderrEof: stderr.eof,
      pids: { bash: processes.pids[0], busyboxCat: processes.pids[1] },
      file: {
        path: "/workspace/result",
        contents: "payload\n",
        ...filesystem.getPosixMetadata("/workspace/result"),
      },
      parentUmask: filesystem.posixPolicy?.umask,
      processes: host.processes.size,
      wakes: wakes.size,
    };
  } finally {
    await prepared.prepared.release();
    if (handle !== undefined) host.reap(handle);
    await host.processes.dispose();
    filesystem.dispose();
    database.close();
    wakes.dispose();
    await Promise.allSettled([stdoutPromise, stderrPromise]);
  }
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return { text: text + decoder.decode(), eof: true };
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function writeAll(filesystem: KernelFileSystem, path: string, bytes: Uint8Array, mode: number) {
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC | KernelOpenFlags.O_WRONLY,
    mode,
  );
  try {
    filesystem.write(fd, bytes, null);
  } finally {
    filesystem.close(fd);
  }
}

function readFile(filesystem: KernelFileSystem, path: string) {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const bytes = new Uint8Array(Number(filesystem.fstat(fd).size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = filesystem.read(fd, bytes.subarray(offset), null);
      if (count === 0) break;
      offset += count;
    }
    return decoder.decode(bytes.subarray(0, offset));
  } finally {
    filesystem.close(fd);
  }
}

function assertArtifact(
  name: string,
  bytes: Uint8Array,
  expected: { readonly bytes: number; readonly sha256: string },
) {
  NodeAssert.equal(bytes.byteLength, expected.bytes, `${name} byte length`);
  NodeAssert.equal(
    NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    expected.sha256,
    `${name} SHA-256`,
  );
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await proveKernelBusyboxCatProgram(), null, 2)}\n`);
}
