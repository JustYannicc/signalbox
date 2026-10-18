import { describe, expect, it } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramExecAdmissionError } from "./KernelAsyncProgram.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const text = (value: string) => new TextEncoder().encode(value);

function setup(programs: ReadonlyMap<string, KernelProgramBinding>) {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, now) }],
  });
  const registry = new KernelProgramRegistry();
  const wakes = new KernelWakeRegistry();
  for (const program of programs.values()) {
    if (registry.register(program.manifest).status !== "ok") {
      throw new Error(`Registration failed: ${program.manifest.name}`);
    }
  }
  const host = new KernelProgramHost({ registry, wakes, programs });
  return {
    host,
    filesystem,
    wakes,
    fixture,
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

function manifest(name: string): RegisteredProgram {
  return {
    name,
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"],
    entrypoint: name,
  };
}

function spawn(host: KernelProgramHost, prepared: ReturnType<KernelProgramHost["prepare"]>) {
  const resolved = host.resolve("/bin/outer");
  if (resolved.status !== "ok") throw new Error("Program resolution failed");
  const result = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args: [],
    env: {},
  });
  if (result.status !== "ok") throw new Error("Program admission failed");
  return result.value;
}

describe("KernelAsyncProgram", () => {
  it("execs in the same process, shares descriptors, and preserves CLOEXEC on failed lookup", async () => {
    let originalIdentity: KernelHandle<"process"> | undefined;
    let sharedFilesystem: KernelFileSystem | undefined;
    let replacementSawCloseOnExec = false;
    let missingLookupPreservedCloseOnExec = false;
    const outerManifest = manifest("outer");
    const replacementManifest = manifest("replacement");
    const context = setup(
      new Map([
        [
          "/bin/outer",
          {
            manifest: outerManifest,
            implementation: {
              kind: "async",
              run: async (program) => {
                originalIdentity = program.identity.handle;
                sharedFilesystem = program.filesystem;
                const kept = program.filesystem.open(
                  "/kept",
                  KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY,
                );
                const removed = program.filesystem.open(
                  "/removed",
                  KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
                );

                try {
                  await program.exec({
                    filesystem: program.filesystem,
                    identity: program.identity,
                    args: [],
                    env: program.env,
                    signal: program.signal,
                    path: "/bin/missing",
                    ...(program.home === undefined ? {} : { home: program.home }),
                  });
                } catch (error) {
                  missingLookupPreservedCloseOnExec =
                    error instanceof Error &&
                    error instanceof KernelProgramExecAdmissionError &&
                    "code" in error &&
                    error.code === "ENOENT" &&
                    program.filesystem.descriptors.has(removed);
                }

                return program.exec({
                  filesystem: program.filesystem,
                  identity: program.identity,
                  args: [String(kept), String(removed)],
                  env: program.env,
                  signal: program.signal,
                  path: "/bin/replacement",
                  ...(program.home === undefined ? {} : { home: program.home }),
                });
              },
            },
          } satisfies KernelProgramBinding,
        ],
        [
          "/bin/replacement",
          {
            manifest: replacementManifest,
            implementation: {
              kind: "async",
              run: async (program) => {
                const info = program.processes.info(program.identity.handle);
                replacementSawCloseOnExec =
                  originalIdentity === program.identity.handle &&
                  sharedFilesystem === program.filesystem &&
                  info.status === "ok" &&
                  info.value.pid === program.identity.pid &&
                  program.filesystem.descriptors.has(Number(program.args[0])) &&
                  !program.filesystem.descriptors.has(Number(program.args[1]));
                const fd = program.filesystem.open(
                  "/exec-result",
                  KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
                );
                program.filesystem.write(fd, text("same process"), null);
                program.filesystem.close(fd);
                return { exitCode: 17, signal: 0, coreDumped: true };
              },
            },
          } satisfies KernelProgramBinding,
        ],
      ]),
    );
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const child = spawn(context.host, prepared);
      await expect(context.host.exitStatus(child)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 17, signal: 0, coreDumped: true },
      });
      expect(missingLookupPreservedCloseOnExec).toBe(true);
      expect(replacementSawCloseOnExec).toBe(true);
      const resultFd = context.filesystem.open("/exec-result", KernelOpenFlags.O_RDONLY);
      const output = new Uint8Array(32);
      const count = context.filesystem.read(resultFd, output, 0n);
      context.filesystem.close(resultFd);
      expect(new TextDecoder().decode(output.subarray(0, count))).toBe("same process");
      expect(() => prepared.filesystem.cwd).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close();
    }
  });

  it("does not resume the old image after a committed replacement fails", async () => {
    let continuedAfterExec = false;
    let replacementFailureIsAdmission = false;
    let closeOnExecWasSwept = false;
    const context = setup(
      new Map([
        [
          "/bin/outer",
          {
            manifest: manifest("outer"),
            implementation: {
              kind: "async",
              run: async (program) => {
                const removed = program.filesystem.open(
                  "/removed-on-exec",
                  KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
                );
                try {
                  const result = await program.exec({
                    filesystem: program.filesystem,
                    identity: program.identity,
                    args: [],
                    env: program.env,
                    signal: program.signal,
                    path: "/bin/replacement",
                    ...(program.home === undefined ? {} : { home: program.home }),
                  });
                  continuedAfterExec = true;
                  return result;
                } catch (error) {
                  replacementFailureIsAdmission = error instanceof KernelProgramExecAdmissionError;
                  closeOnExecWasSwept = !program.filesystem.descriptors.has(removed);
                  throw error;
                }
              },
            },
          } satisfies KernelProgramBinding,
        ],
        [
          "/bin/replacement",
          {
            manifest: manifest("replacement"),
            implementation: {
              kind: "async",
              run: async () => {
                await Promise.resolve();
                throw Object.assign(new Error("replacement failed"), { code: "EIO" });
              },
            },
          } satisfies KernelProgramBinding,
        ],
      ]),
    );
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const child = spawn(context.host, prepared);
      await expect(context.host.exitStatus(child)).resolves.toMatchObject({
        status: "error",
        error: { code: "IO_ERROR" },
      });
      expect(replacementFailureIsAdmission).toBe(false);
      expect(closeOnExecWasSwept).toBe(true);
      expect(continuedAfterExec).toBe(false);
      expect(context.host.processes.reap(child).status).toBe("error");
    } finally {
      await context.close();
    }
  });

  it("does not leak a nested exec admission error across a committed replacement", async () => {
    let nestedCallWasAdmission = false;
    let outerSawAdmission = false;
    let outerSawErrno: unknown;
    let closeOnExecWasSwept = false;
    let continuedAfterExec = false;
    const context = setup(
      new Map([
        [
          "/bin/outer",
          {
            manifest: manifest("outer"),
            implementation: {
              kind: "async",
              run: async (program) => {
                const removed = program.filesystem.open(
                  "/removed-on-exec",
                  KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
                );
                try {
                  const result = await program.exec({
                    filesystem: program.filesystem,
                    identity: program.identity,
                    args: [],
                    env: program.env,
                    signal: program.signal,
                    path: "/bin/replacement",
                    ...(program.home === undefined ? {} : { home: program.home }),
                  });
                  continuedAfterExec = true;
                  return result;
                } catch (error) {
                  outerSawAdmission = error instanceof KernelProgramExecAdmissionError;
                  outerSawErrno =
                    error instanceof Error && "code" in error ? error.code : undefined;
                  closeOnExecWasSwept = !program.filesystem.descriptors.has(removed);
                  throw error;
                }
              },
            },
          } satisfies KernelProgramBinding,
        ],
        [
          "/bin/replacement",
          {
            manifest: manifest("replacement"),
            implementation: {
              kind: "async",
              run: async (program) => {
                try {
                  return await program.exec({
                    filesystem: program.filesystem,
                    identity: program.identity,
                    args: [],
                    env: program.env,
                    signal: program.signal,
                    path: "/bin/missing",
                    ...(program.home === undefined ? {} : { home: program.home }),
                  });
                } catch (error) {
                  nestedCallWasAdmission = error instanceof KernelProgramExecAdmissionError;
                  throw error;
                }
              },
            },
          } satisfies KernelProgramBinding,
        ],
      ]),
    );
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const child = spawn(context.host, prepared);
      await expect(context.host.exitStatus(child)).resolves.toMatchObject({
        status: "error",
        error: { code: "IO_ERROR" },
      });
      expect(nestedCallWasAdmission).toBe(true);
      expect(outerSawAdmission).toBe(false);
      expect(outerSawErrno).toBe("ENOENT");
      expect(closeOnExecWasSwept).toBe(true);
      expect(continuedAfterExec).toBe(false);
      expect(context.host.processes.reap(child).status).toBe("error");
    } finally {
      await context.close();
    }
  });

  it("lets an async program signal itself before its first await", async () => {
    let selfSignalAccepted = false;
    const context = setup(
      new Map([
        [
          "/bin/outer",
          {
            manifest: manifest("outer"),
            implementation: {
              kind: "async",
              run: async (program) => {
                selfSignalAccepted =
                  program.processes.signal(program.identity.handle, 9).status === "ok";
                await Promise.resolve();
                return { exitCode: 0, signal: 0, coreDumped: false };
              },
            },
          } satisfies KernelProgramBinding,
        ],
      ]),
    );
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const child = spawn(context.host, prepared);
      await expect(context.host.exitStatus(child)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 0, signal: 9 },
      });
      expect(selfSignalAccepted).toBe(true);
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close();
    }
  });

  it("reports explicit signals as exit status and parent abort as cancellation", async () => {
    const outerManifest = manifest("outer");
    const starts = [deferred(), deferred()];
    let startIndex = 0;
    const context = setup(
      new Map([
        [
          "/bin/outer",
          {
            manifest: outerManifest,
            implementation: waitingProgram(() => starts[startIndex++]!.resolve()),
          } satisfies KernelProgramBinding,
        ],
      ]),
    );
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const child = spawn(context.host, prepared);
      await starts[0]!.promise;
      const signal = context.host.processes.signal(child, 9);
      expect(signal.status).toBe("ok");
      await expect(context.host.exitStatus(child)).resolves.toMatchObject({
        status: "ok",
        value: { exitCode: 0, signal: 9 },
      });
      expect(() => prepared.filesystem.cwd).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(context.host.processes.reap(child).status).toBe("ok");

      const parentAbort = new AbortController();
      const parentPrepared = context.host.prepare({
        filesystem: context.filesystem,
        signal: parentAbort.signal,
      });
      const parentChild = spawn(context.host, parentPrepared);
      await starts[1]!.promise;
      parentAbort.abort();
      await expect(context.host.exitStatus(parentChild)).resolves.toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(() => parentPrepared.filesystem.cwd).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(context.host.processes.reap(parentChild)).toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(context.host.processes.info(parentChild)).toMatchObject({
        status: "error",
        error: { code: "INVALID_HANDLE" },
      });
    } finally {
      await context.close();
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function waitingProgram(onStart: () => void): KernelProgramBinding["implementation"] {
  return {
    kind: "async",
    run: ({ signal }) =>
      new Promise<never>((_resolve, reject) => {
        onStart();
        const abort = () => reject(new Error("aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
  };
}
