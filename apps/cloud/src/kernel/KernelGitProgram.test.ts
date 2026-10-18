import { describe, expect, it } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  kernelOk,
  type KernelHandle,
  type KernelResult,
} from "./KernelAbi.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProcessTable, type KernelExitStatus } from "./KernelProcessTable.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KERNEL_GIT_PROGRAM_MANIFEST, createKernelGitProgram } from "./KernelGitProgram.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const encoder = new TextEncoder();
const credentials = { uid: 1001, gid: 1002, euid: 1001, egid: 1002 } as const;
const rootMetadata = { mode: 0o755, uid: credentials.uid, gid: credentials.gid } as const;
const GIT_IMPORTS = Object.freeze({
  nimbus_fs: ["fd_chmod", "fd_stat", "path_access", "path_chmod", "path_stat", "umask"],
  nimbus_proc: ["dup", "dup2", "ids", "kill", "pipe", "spawn", "startup_cwd", "wait", "start"],
  wasi_snapshot_preview1: [
    "args_get",
    "args_sizes_get",
    "clock_time_get",
    "environ_get",
    "environ_sizes_get",
    "fd_close",
    "fd_fdstat_get",
    "fd_fdstat_set_flags",
    "fd_filestat_set_size",
    "fd_pread",
    "fd_prestat_get",
    "fd_prestat_dir_name",
    "fd_read",
    "fd_readdir",
    "fd_renumber",
    "fd_seek",
    "fd_sync",
    "fd_tell",
    "fd_write",
    "path_create_directory",
    "path_filestat_get",
    "path_filestat_set_times",
    "path_link",
    "path_open",
    "path_readlink",
    "path_remove_directory",
    "path_rename",
    "path_symlink",
    "path_unlink_file",
    "poll_oneoff",
    "proc_exit",
    "random_get",
    "sock_shutdown",
  ],
});
const PROBE_MANIFEST = Object.freeze({
  name: "git-test-probe",
  version: "1.0.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze([]),
  entrypoint: "git-test-probe-v1",
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createFilesystem() {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n);
  storage.posix.initialize(storage.root, rootMetadata);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    stdio: [
      { readInto: () => 0 },
      { write: (source) => source.byteLength },
      { write: (source) => source.byteLength },
    ],
    posix: { credentials, umask: 0o022 },
  });
  filesystem.mkdir("/work");
  filesystem.mkdir("/home");
  filesystem.mkdir("/home/test");
  return { filesystem, fixture, storage };
}

function createPublicHost(
  filesystem: KernelFileSystem,
  guest: WebAssembly.Module,
  childRun: KernelProgramBinding["implementation"],
  gitCredentials = credentials,
  onGitComplete?: (filesystem: KernelFileSystem) => void,
) {
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  for (const manifest of [KERNEL_GIT_PROGRAM_MANIFEST, PROBE_MANIFEST]) {
    const registration = registry.register(manifest);
    if (registration.status !== "ok") throw new Error("Test program registration failed");
  }
  const gitProgram = createKernelGitProgram({ module: guest, credentials: gitCredentials });
  const observedGitProgram = {
    kind: "async" as const,
    run: async (context: KernelAsyncProgramContext) => {
      const status = await gitProgram.run(context);
      onGitComplete?.(context.filesystem);
      return status;
    },
  };
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      [
        "/usr/bin/git",
        {
          manifest: KERNEL_GIT_PROGRAM_MANIFEST,
          implementation: observedGitProgram,
        },
      ],
      ["/bin/probe", { manifest: PROBE_MANIFEST, implementation: childRun }],
    ]),
  });
  return { host, wakes };
}

function spawnGit(host: KernelProgramHost, filesystem: KernelFileSystem) {
  const prepared = host.prepare({ filesystem, home: "/home/test" }, { cwd: "/work" });
  const resolved = host.resolve("/usr/bin/git");
  if (resolved.status !== "ok") throw new Error("Git program did not resolve");
  const spawned = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args: ["/usr/bin/git"],
    env: {},
  });
  if (spawned.status !== "ok") throw new Error(`Git admission failed: ${JSON.stringify(spawned)}`);
  return spawned.value;
}

async function finishGit(host: KernelProgramHost, handle: KernelHandle<"process">) {
  const status = await host.exitStatus(handle);
  if (status.status !== "ok") throw new Error(`Git run failed: ${JSON.stringify(status)}`);
  const reaped = host.reap(handle);
  if (reaped.status !== "ok")
    throw new Error(`Git process was not reaped: ${JSON.stringify(reaped)}`);
  return status.value;
}

function childReader(
  onStarted?: (input: {
    readonly identity: KernelAsyncProgramContext["identity"];
    readonly filesystem: KernelFileSystem;
  }) => void,
) {
  return {
    kind: "async" as const,
    run: async (context: KernelAsyncProgramContext) => {
      const descriptor = context.filesystem.descriptors.get(0);
      const readInto = descriptor.stdio?.readInto;
      if (!readInto) throw new Error("Probe child did not inherit stdin");
      const target = new Uint8Array(64);
      const firstRead = readInto(target, descriptor.flags);
      onStarted?.({ identity: context.identity, filesystem: context.filesystem });
      let count = await firstRead;
      for (;;) {
        if (count === 0) break;
        count = await readInto(target, descriptor.flags);
      }
      return { exitCode: 0, signal: 0, coreDumped: false };
    },
  } satisfies KernelProgramBinding["implementation"];
}

function gitGuest(
  mode:
    | "pipe-eof"
    | "wait"
    | "pending"
    | "path-stat"
    | "path-chmod"
    | "fd-stat"
    | "fd-chmod"
    | "umask"
    | "access",
  pathValue = "/work/file",
  descriptorFd = 3,
) {
  const imports: { module: keyof typeof GIT_IMPORTS; name: string; type: number }[] = [];
  const index = new Map<string, number>();
  for (const [module, names] of Object.entries(GIT_IMPORTS) as [
    keyof typeof GIT_IMPORTS,
    readonly string[],
  ][]) {
    for (const name of names) {
      index.set(`${module}.${name}`, imports.length);
      imports.push({ module, name, type: importType(module, name) });
    }
  }

  const data = new Uint8Array(256);
  const argv = encoder.encode("/bin/probe\0child\0");
  const env = new Uint8Array();
  const cwd = encoder.encode("/work");
  data.set(argv, 0);
  data.set(env, 64);
  data.set(cwd, 96);
  const path = encoder.encode(pathValue);
  data.set(path, 128);

  const const32 = (value: number) => [0x41, ...sleb(value)];
  const call = (key: string) => [0x10, ...uleb(index.get(key)!)];
  const load = (address: number) => [...const32(address), 0x28, 2, 0];
  const procExit = call("wasi_snapshot_preview1.proc_exit");
  const instructions: number[] = [];
  const ensureStatus = () => [0x21, 0, 0x20, 0, 0x04, 0x40, 0x20, 0, ...procExit, 0x00, 0x0b];
  const spawnProbe = (stdinFd: number, start = true) => [
    ...const32(0),
    ...const32(argv.byteLength),
    ...const32(64),
    ...const32(0),
    ...const32(96),
    ...const32(cwd.byteLength),
    ...const32(stdinFd),
    ...const32(1),
    ...const32(2),
    ...const32(256),
    ...call("nimbus_proc.spawn"),
    0x1a,
    ...load(256),
    0x21,
    0,
    ...(start ? [0x20, 0, ...call("nimbus_proc.start"), 0x1a] : []),
  ];

  if (mode === "pipe-eof" || mode === "wait") {
    instructions.push(
      ...const32(400),
      ...call("nimbus_proc.pipe"),
      0x1a,
      ...const32(0),
      ...const32(argv.byteLength),
      ...const32(64),
      ...const32(0),
      ...const32(96),
      ...const32(cwd.byteLength),
      ...load(400),
      ...const32(1),
      ...const32(2),
      ...const32(256),
      ...call("nimbus_proc.spawn"),
      0x1a,
      ...load(256),
      0x21,
      0,
      0x20,
      0,
      ...call("nimbus_proc.start"),
      0x1a,
    );
    if (mode === "pipe-eof") {
      instructions.push(...load(404), ...call("wasi_snapshot_preview1.fd_close"), 0x1a);
      instructions.push(...load(400), ...call("wasi_snapshot_preview1.fd_close"), 0x1a);
    }
    instructions.push(
      0x20,
      0,
      ...const32(0),
      ...const32(260),
      ...const32(264),
      ...call("nimbus_proc.wait"),
      0x1a,
    );
    if (mode === "wait") {
      instructions.push(...load(404), ...call("wasi_snapshot_preview1.fd_close"), 0x1a);
      instructions.push(...load(400), ...call("wasi_snapshot_preview1.fd_close"), 0x1a);
    }
    instructions.push(...load(260), ...procExit, 0x00);
  } else if (mode === "pending") {
    instructions.push(...spawnProbe(-1, false), ...const32(0), ...procExit, 0x00);
  } else if (mode === "path-stat") {
    instructions.push(
      ...const32(-100),
      ...const32(1),
      ...const32(128),
      ...const32(path.byteLength),
      ...const32(160),
      ...call("nimbus_fs.path_stat"),
      ...ensureStatus(),
      ...load(160 + 64),
      ...procExit,
      0x00,
    );
  } else if (mode === "path-chmod") {
    instructions.push(
      ...const32(-100),
      ...const32(1),
      ...const32(128),
      ...const32(path.byteLength),
      ...const32(0o640),
      ...call("nimbus_fs.path_chmod"),
      ...procExit,
      0x00,
    );
  } else if (mode === "fd-stat") {
    instructions.push(
      ...const32(descriptorFd),
      ...const32(160),
      ...call("nimbus_fs.fd_stat"),
      ...ensureStatus(),
      ...load(160 + 64),
      ...procExit,
      0x00,
    );
  } else if (mode === "fd-chmod") {
    instructions.push(
      ...const32(descriptorFd),
      ...const32(0o600),
      ...call("nimbus_fs.fd_chmod"),
      ...procExit,
      0x00,
    );
  } else if (mode === "umask") {
    instructions.push(
      ...const32(0o027),
      ...const32(256),
      ...call("nimbus_fs.umask"),
      0x1a,
      ...load(256),
      ...procExit,
      0x00,
    );
  } else {
    instructions.push(
      ...const32(-100),
      ...const32(1),
      ...const32(128),
      ...const32(path.byteLength),
      ...const32(4),
      ...call("nimbus_fs.path_access"),
      ...procExit,
      0x00,
    );
  }

  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [
        8,
        ...funcType([], []),
        ...funcType(Array(10).fill(0x7f), [0x7f]),
        ...funcType([0x7f], [0x7f]),
        ...funcType([0x7f, 0x7f], [0x7f]),
        ...funcType(Array(4).fill(0x7f), [0x7f]),
        ...funcType(Array(5).fill(0x7f), [0x7f]),
        ...funcType([0x7f], []),
        ...funcType([], [0x7f]),
      ]),
      ...section(2, [
        imports.length,
        ...imports.flatMap(({ module, name, type }) => [
          ...nameBytes(module),
          ...nameBytes(name),
          0,
          ...uleb(type),
        ]),
      ]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...nameBytes("memory"), 2, 0, ...nameBytes("_start"), 0, imports.length]),
      ...section(10, [1, ...uleb(instructions.length + 4), 1, 1, 0x7f, ...instructions, 0x0b]),
      ...section(11, [1, 0, 0x41, ...sleb(0), 0x0b, ...uleb(data.length), ...data]),
    ]),
  );
}

function importType(module: string, name: string): number {
  if (module === "nimbus_proc") {
    if (name === "spawn") return 1;
    if (name === "wait") return 4;
    if (name === "kill" || name === "dup2") return 3;
    if (name === "pipe" || name === "start") return 2;
  }
  if (module === "nimbus_fs") {
    if (name === "path_stat" || name === "path_access" || name === "path_chmod") return 5;
    if (name === "fd_stat" || name === "fd_chmod" || name === "umask") return 3;
  }
  if (module === "wasi_snapshot_preview1") {
    if (name === "proc_exit") return 6;
    if (name === "fd_close") return 2;
  }
  return 0;
}

function funcType(params: readonly number[], results: readonly number[]) {
  return [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
}

function section(id: number, contents: readonly number[]) {
  return [id, ...uleb(contents.length), ...contents];
}

function nameBytes(value: string) {
  const bytes = [...encoder.encode(value)];
  return [...uleb(bytes.length), ...bytes];
}

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return bytes;
}

function sleb(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const next = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && (next & 0x40) === 0) || (value === -1 && (next & 0x40) !== 0);
    bytes.push(next | (done ? 0 : 0x80));
    if (done) return bytes;
  }
}

describe("KernelGitProgram public entry", () => {
  it("reads persisted POSIX metadata and applies chmod, umask, and access through the guest ABI", async () => {
    const { filesystem, fixture, storage } = createFilesystem();
    let fileFd: number | undefined;
    try {
      const parent = filesystem.resolve("/work");
      const inode = filesystem.createInode(
        parent.mount,
        parent.inode,
        "file",
        { type: "file", exclusive: true },
        0o6755,
      );
      fileFd = filesystem.open("/work/file", KernelOpenFlags.O_RDWR);
      await Promise.resolve(parent.mount.storage.release(inode));

      const stat = await runFsGuest(filesystem, gitGuest("path-stat"));
      expect(stat.exitCode).toBe(0o106755);
      expect(filesystem.getPosixMetadata("/work/file")).toEqual({
        mode: 0o6755,
        uid: credentials.uid,
        gid: credentials.gid,
      });

      const pathChmod = await runFsGuest(filesystem, gitGuest("path-chmod"));
      expect(pathChmod.exitCode).toBe(0);
      expect(filesystem.getPosixMetadata("/work/file").mode).toBe(0o640);
      const fdStat = await runFsGuest(filesystem, gitGuest("fd-stat", "/work/file", fileFd));
      expect(fdStat.exitCode).toBe(0o100640);
      const fdChmod = await runFsGuest(filesystem, gitGuest("fd-chmod", "/work/file", fileFd));
      expect(fdChmod.exitCode).toBe(0);
      expect(filesystem.getPosixMetadataForFd(fileFd).mode).toBe(0o600);

      let guestUmask: number | undefined;
      const umask = await runFsGuest(filesystem, gitGuest("umask"), (guestFilesystem) => {
        guestUmask = guestFilesystem.posixPolicy?.umask;
      });
      expect(umask.exitCode).toBe(0o022);
      expect(guestUmask).toBe(0o027);

      filesystem.chmod("/work/file", 0);
      const denied = await runFsGuest(filesystem, gitGuest("access"));
      expect(denied.exitCode).toBe(2);

      const legacy = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
      try {
        legacy.mkdir("/legacy");
        const unsupported = await runFsGuest(filesystem, gitGuest("path-stat", "/legacy"));
        expect(unsupported.exitCode).toBe(58);
      } finally {
        legacy.dispose();
      }
    } finally {
      if (fileFd !== undefined) filesystem.close(fileFd);
      filesystem.dispose();
      fixture.close();
    }
  });

  it("rejects split real and effective identities before program admission", () => {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() =>
      createKernelGitProgram({
        module,
        credentials: { ...credentials, euid: credentials.uid + 1 },
      }),
    ).toThrow(RangeError);
    expect(createKernelGitProgram({ module, credentials: { ...credentials } }).kind).toBe("async");
  });

  it("closes inherited pipe aliases in children so a pager-style reader reaches EOF", async () => {
    const { filesystem, fixture } = createFilesystem();
    const unrelatedFd = filesystem.open(
      "/unrelated",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
    );
    const readStarted = deferred<{ readonly filesystem: KernelFileSystem }>();
    const { host, wakes } = createPublicHost(
      filesystem,
      gitGuest("pipe-eof"),
      childReader(({ filesystem: child }) => readStarted.resolve({ filesystem: child })),
    );
    try {
      const handle = spawnGit(host, filesystem);
      const child = await readStarted.promise;
      expect(child.filesystem.descriptors.has(unrelatedFd)).toBe(true);
      expect(child.filesystem.descriptors.has(4)).toBe(true);
      expect(child.filesystem.descriptors.has(5)).toBe(false);
      expect(child.filesystem.descriptors.has(6)).toBe(false);
      await expect(finishGit(host, handle)).resolves.toMatchObject({ exitCode: 0, signal: 0 });
      expect(host.processes.size).toBe(0);
      expect(wakes.size).toBe(0);
    } finally {
      await host.processes.dispose();
      filesystem.close(unrelatedFd);
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("routes inherited pipe cancellation through the child signal while Git stays live", async () => {
    const { filesystem, fixture } = createFilesystem();
    const readStarted = deferred<{
      readonly handle: KernelAsyncProgramContext["identity"]["handle"];
    }>();
    const { host, wakes } = createPublicHost(
      filesystem,
      gitGuest("wait"),
      childReader(({ identity }) => readStarted.resolve({ handle: identity.handle })),
    );
    try {
      const git = spawnGit(host, filesystem);
      const child = await readStarted.promise;
      const gitStatus = host.processes.exitStatus(git);
      const childStatus = host.processes.exitStatus(child.handle);
      expect(gitStatus.status).toBe("would_block");
      expect(childStatus.status).toBe("would_block");
      if (gitStatus.status === "would_block") wakes.release(gitStatus.wakeToken);
      if (childStatus.status === "would_block") wakes.release(childStatus.wakeToken);
      expect(host.processes.signal(child.handle, 15).status).toBe("ok");
      await expect(finishGit(host, git)).resolves.toMatchObject({ exitCode: 15, signal: 0 });
      expect(host.processes.size).toBe(0);
      expect(wakes.size).toBe(0);
    } finally {
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("reaps blocked children on repeated parent cancellation and drops unstarted requests", async () => {
    const { filesystem, fixture } = createFilesystem();
    const started = Array.from({ length: 3 }, () =>
      deferred<{ readonly handle: KernelAsyncProgramContext["identity"]["handle"] }>(),
    );
    const pendingStarts = [...started];
    const { host, wakes } = createPublicHost(
      filesystem,
      gitGuest("wait"),
      childReader(({ identity }) => {
        const next = pendingStarts.shift();
        if (!next) throw new Error("More Git children started than expected");
        next.resolve({ handle: identity.handle });
      }),
    );
    try {
      for (let index = 0; index < 3; index++) {
        const git = spawnGit(host, filesystem);
        const child = await started[index]!.promise;
        expect(host.processes.size).toBe(2);
        expect(host.processes.signal(git, 15).status).toBe("ok");
        await expect(host.exitStatus(git)).resolves.toMatchObject({
          status: "ok",
          value: { exitCode: 0, signal: 15 },
        });
        expect(host.reap(git).status).toBe("ok");
        expect(host.processes.info(child.handle)).toMatchObject({
          status: "error",
          error: { code: "INVALID_HANDLE" },
        });
        expect(host.processes.size).toBe(0);
        expect(wakes.size).toBe(0);
      }

      const pendingHost = createPublicHost(filesystem, gitGuest("pending"), {
        kind: "javascript",
        runInline: () => 0,
      });
      const pendingGit = spawnGit(pendingHost.host, filesystem);
      await expect(finishGit(pendingHost.host, pendingGit)).resolves.toMatchObject({ exitCode: 0 });
      expect(pendingHost.host.processes.size).toBe(0);
      expect(pendingHost.wakes.size).toBe(0);
      await pendingHost.host.processes.dispose();
      pendingHost.wakes.dispose();
    } finally {
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("captures a child admitted just after cancellation, then kills and reaps it", async () => {
    const { filesystem, fixture } = createFilesystem();
    const wakes = new KernelWakeRegistry();
    const processes = new KernelProcessTable({ wakes });
    const signal = new AbortController();
    const admissionStarted = deferred<void>();
    const finishAdmission = deferred<KernelResult<KernelHandle<"process">>>();
    const finishRoot = deferred<KernelExitStatus>();
    let rootIdentity: KernelAsyncProgramContext["identity"] | undefined;
    let childHandle: KernelAsyncProgramContext["identity"]["handle"] | undefined;
    let stopChild: (() => void) | undefined;
    const root = processes.spawn(
      undefined,
      (identity) => {
        rootIdentity = identity;
        return {
          completion: finishRoot.promise,
          signal: () => {
            finishRoot.resolve({ exitCode: 0, signal: 0, coreDumped: false });
            return kernelOk(undefined);
          },
        };
      },
      () => undefined,
    );
    if (root.status !== "ok" || !rootIdentity)
      throw new Error("Could not create public test identity");
    const context: KernelAsyncProgramContext = {
      filesystem,
      home: undefined,
      args: [],
      env: {},
      identity: rootIdentity,
      signal: signal.signal,
      processes,
      wakes,
      spawn: async () => {
        const child = processes.spawn(
          rootIdentity!.handle,
          () => ({
            completion: new Promise((resolve) => {
              stopChild = () => resolve({ exitCode: 0, signal: 9, coreDumped: false });
            }),
            signal: () => {
              stopChild?.();
              return kernelOk(undefined);
            },
          }),
          () => undefined,
        );
        if (child.status !== "ok") return child;
        childHandle = child.value.handle;
        admissionStarted.resolve();
        return finishAdmission.promise;
      },
      exec: async () => {
        throw new Error("Unexpected test exec");
      },
    };
    try {
      const program = createKernelGitProgram({
        module: gitGuest("wait"),
        credentials,
      });
      const running = program.run(context);
      await admissionStarted.promise;
      signal.abort();
      if (!childHandle) throw new Error("Child admission did not create a handle");
      finishAdmission.resolve({ status: "ok", value: childHandle });
      await expect(running).rejects.toMatchObject({ name: "KernelProcessCancelledError" });
      expect(processes.info(childHandle)).toMatchObject({
        status: "error",
        error: { code: "INVALID_HANDLE" },
      });
      expect(processes.size).toBe(1);
      expect(wakes.size).toBe(0);
    } finally {
      finishRoot.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      const rootStatus = await waitForTerminal(processes, wakes, rootIdentity.handle);
      expect(rootStatus.status).toBe("ok");
      expect(processes.reap(rootIdentity.handle).status).toBe("ok");
      await processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });
});

async function runFsGuest(
  filesystem: KernelFileSystem,
  module: WebAssembly.Module,
  onGitComplete?: (filesystem: KernelFileSystem) => void,
) {
  const runner = createPublicHost(
    filesystem,
    module,
    {
      kind: "javascript",
      runInline: () => 0,
    },
    credentials,
    onGitComplete,
  );
  const handle = spawnGit(runner.host, filesystem);
  const status = await runner.host.exitStatus(handle);
  expect(status.status).toBe("ok");
  if (status.status !== "ok") throw new Error("Public Git filesystem probe failed");
  expect(runner.host.reap(handle).status).toBe("ok");
  await runner.host.processes.dispose();
  runner.wakes.dispose();
  return status.value;
}

async function waitForTerminal(
  processes: KernelProcessTable,
  wakes: KernelWakeRegistry,
  handle: KernelHandle<"process">,
) {
  for (;;) {
    const result = processes.exitStatus(handle);
    if (result.status !== "would_block") return result;
    try {
      await wakes.wait(result.wakeToken);
    } finally {
      wakes.release(result.wakeToken);
    }
  }
}
