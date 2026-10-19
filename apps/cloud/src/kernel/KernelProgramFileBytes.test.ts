import { describe, expect, it } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import type { KernelFileByteView } from "./KernelFileBytes.ts";
import { canonicalFileByteSelection } from "./KernelFileBytes.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramExecAdmissionError } from "./KernelAsyncProgram.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import type { Storage } from "./storage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();

function manifest(name: string): RegisteredProgram {
  return {
    name,
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"],
    entrypoint: name,
  };
}

function viewFor(storage: Storage): KernelFileByteView {
  return {
    completion: "sync",
    storage,
    bind(inode) {
      return {
        stat: () => storage.stat(inode),
        readInto: (offset, target) => storage.readInto(inode, offset, target),
        write: (offset, source) => storage.write(inode, offset, source),
        append: (source) => storage.append(inode, source),
        truncate: (size) => storage.truncate(inode, size),
        sync: (dataOnly) => storage.sync(inode, dataOnly),
        release: () => undefined,
      };
    },
  };
}

function writeFile(storage: Storage, name: string, value: string): void {
  const inode = storage.create(storage.root, name, { type: "file", exclusive: true });
  storage.write(inode, 0n, encoder.encode(value));
  storage.release(inode);
}

function spawnRequest(
  execPath: string,
  actions: AgentOsSpawnRequest["actions"] = [],
): AgentOsSpawnRequest {
  return {
    execPath,
    argv: [execPath],
    env: {},
    actions,
    attributes: {
      flags: 0,
      defaultMask: { low: 0, high: 0 },
      signalMask: { low: 0, high: 0 },
      processGroup: 0,
    },
    pidPointer: 0,
  };
}

function wasmWithUnknownImport(): WebAssembly.Module {
  const section = (id: number, payload: number[]) => [id, payload.length, ...payload];
  const name = (value: string) => [value.length, ...encoder.encode(value)];
  return new WebAssembly.Module(
    Uint8Array.from([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0x60, 0, 0]),
      ...section(2, [1, ...name("unknown"), ...name("initialize"), 0, 0]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...name("_start"), 0, 0]),
      ...section(10, [1, 2, 0, 0x0b]),
    ]),
  );
}

function wasmWithFunctionAsMemoryImport(): WebAssembly.Module {
  const section = (id: number, payload: number[]) => [id, payload.length, ...payload];
  const name = (value: string) => [value.length, ...encoder.encode(value)];
  return new WebAssembly.Module(
    Uint8Array.from([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0x60, 0, 0]),
      ...section(2, [1, ...name("host_process"), ...name("fd_setfd"), 2, 0, 1]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...name("_start"), 0, 0]),
      ...section(10, [1, 2, 0, 0x0b]),
    ]),
  );
}

function wasmWithStartCheckingCloseOnExecWasSwept(fd: number): WebAssembly.Module {
  const section = (id: number, payload: number[]) => [id, payload.length, ...payload];
  const name = (value: string) => [value.length, ...encoder.encode(value)];
  return new WebAssembly.Module(
    Uint8Array.from([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...section(1, [2, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
      ...section(2, [1, ...name("host_process"), ...name("fd_setfd"), 0, 0]),
      ...section(3, [1, 1]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("_start"), 0, 1, ...name("memory"), 2, 0]),
      ...section(8, [1]),
      ...section(10, [1, 13, 0, 0x41, fd, 0x41, 0, 0x10, 0, 0x45, 0x04, 0x40, 0, 0x0b, 0x0b]),
    ]),
  );
}

function setup(
  programs: ReadonlyMap<string, KernelProgramBinding>,
  selectFileBytes: NonNullable<
    ConstructorParameters<typeof KernelProgramHost>[0]["selectFileBytes"]
  >,
) {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, now);
  const view = viewFor(storage);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    fileBytes: { kind: "view", view },
  });
  const registry = new KernelProgramRegistry();
  const wakes = new KernelWakeRegistry();
  for (const binding of programs.values()) {
    if (registry.register(binding.manifest).status !== "ok")
      throw new Error(`Registration failed: ${binding.manifest.name}`);
  }
  const host = new KernelProgramHost({ registry, wakes, programs, selectFileBytes });
  return {
    fixture,
    filesystem,
    host,
    storage,
    view,
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

function admitted(
  host: KernelProgramHost,
  prepared: ReturnType<KernelProgramHost["prepare"]>,
  args: readonly string[] = [],
) {
  const resolved = host.resolve("/bin/outer");
  if (resolved.status !== "ok") throw new Error("Outer program resolution failed");
  const child = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args,
    env: {},
  });
  if (child.status !== "ok") throw new Error("Outer program admission failed");
  return child.value;
}

describe("KernelProgramHost file byte selection", () => {
  it("selects canonical bytes for a nested child before its open actions", async () => {
    let childSawCanonical = false;
    let childAliasesSharedOffset = false;
    let parentStayedProjected = false;
    let selectorParent: string | undefined;
    let childError: string | undefined;
    let spawnError: string | undefined;
    let childHandle: KernelHandle<"process"> | undefined;
    const outer: KernelProgramBinding = {
      manifest: manifest("outer"),
      implementation: {
        kind: "async",
        run: async (program) => {
          const child = await program.spawn(
            spawnRequest("/bin/canonical", [
              {
                kind: "open",
                fd: 4,
                sourceFd: 0,
                flags: KernelOpenFlags.O_RDONLY,
                mode: 0,
                path: "/data",
              },
              { kind: "dup2", fd: 5, sourceFd: 4, flags: 0, mode: 0 },
            ]),
          );
          if (child.status !== "ok") {
            spawnError =
              child.status === "error"
                ? `${child.error.code} ${child.error.message}`
                : "would_block";
            return { exitCode: 1, signal: 0, coreDumped: false };
          }
          childHandle = child.value;
          parentStayedProjected = program.filesystem.fileBytes.kind === "view";
          return { exitCode: 0, signal: 0, coreDumped: false };
        },
      },
    };
    const canonical: KernelProgramBinding = {
      manifest: manifest("canonical"),
      implementation: {
        kind: "javascript",
        runInline: ({ filesystem }) => {
          try {
            const first = filesystem.descriptors.get(4);
            const alias = filesystem.descriptors.get(5);
            first.offset = 12n;
            childSawCanonical = first.byteView === undefined && alias.byteView === undefined;
            childAliasesSharedOffset = alias.offset === 12n;
            return 0;
          } catch (error) {
            childError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            throw error;
          }
        },
      },
    };
    const context = setup(
      new Map([
        ["/bin/outer", outer],
        ["/bin/canonical", canonical],
      ]),
      ({ executable, filesystem, parent }) => {
        if (executable === "/bin/canonical") selectorParent = parent?.id;
        return executable === "/bin/canonical" ? canonicalFileByteSelection : filesystem.fileBytes;
      },
    );
    writeFile(context.storage, "data", "shared bytes");
    const outerHandle = admitted(
      context.host,
      context.host.prepare({ filesystem: context.filesystem }),
    );
    try {
      const outerStatus = await context.host.exitStatus(outerHandle);
      if (outerStatus.status === "error")
        throw new Error(
          `${outerStatus.error.message}; spawn error: ${spawnError ?? "none"}; child error: ${childError ?? "none"}`,
        );
      expect(outerStatus.status).toBe("ok");
      expect(spawnError).toBeUndefined();
      if (!childHandle) throw new Error("Nested child was not admitted");
      const childStatus = await context.host.exitStatus(childHandle);
      if (childStatus.status === "error")
        throw new Error(`${childStatus.error.message}; child error: ${childError ?? "none"}`);
      expect(childStatus.status).toBe("ok");
      expect(childSawCanonical).toBe(true);
      expect(childAliasesSharedOffset).toBe(true);
      expect(parentStayedProjected).toBe(true);
      expect(selectorParent).toBe(outerHandle.id);
      expect(context.host.processes.reap(childHandle).status).toBe("ok");
      expect(context.host.processes.reap(outerHandle).status).toBe("ok");
    } finally {
      await context.close();
    }
  });

  it("rejects an incompatible inherited descriptor before child admission without touching the parent", async () => {
    let rejection: unknown;
    let parentStillUsable = false;
    let parentStateUnchanged = false;
    const outer: KernelProgramBinding = {
      manifest: manifest("outer"),
      implementation: {
        kind: "async",
        run: async (program) => {
          const kept = program.filesystem.open("/data", KernelOpenFlags.O_RDONLY);
          const closeOnExec = program.filesystem.open(
            "/data",
            KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
          );
          program.filesystem.descriptors.get(kept).offset = 4n;
          program.filesystem.descriptors.get(closeOnExec).offset = 7n;
          const keptDescriptor = program.filesystem.descriptors.get(kept);
          const closeOnExecDescriptor = program.filesystem.descriptors.get(closeOnExec);
          const before = [
            keptDescriptor.offset,
            keptDescriptor.closeOnExec,
            closeOnExecDescriptor.offset,
            closeOnExecDescriptor.closeOnExec,
          ];
          const child = await program.spawn(spawnRequest("/bin/canonical"));
          rejection = child.status === "error" ? child.error.code : undefined;
          parentStillUsable = program.filesystem.stat("/data").size === 12n;
          parentStateUnchanged =
            keptDescriptor.offset === before[0] &&
            keptDescriptor.closeOnExec === before[1] &&
            closeOnExecDescriptor.offset === before[2] &&
            closeOnExecDescriptor.closeOnExec === before[3] &&
            program.filesystem.fileBytes.kind === "view" &&
            program.processes.size === 1;
          return { exitCode: 0, signal: 0, coreDumped: false };
        },
      },
    };
    const canonical: KernelProgramBinding = {
      manifest: manifest("canonical"),
      implementation: { kind: "javascript", runInline: () => 0 },
    };
    const context = setup(
      new Map([
        ["/bin/outer", outer],
        ["/bin/canonical", canonical],
      ]),
      ({ executable, filesystem }) =>
        executable === "/bin/canonical" ? canonicalFileByteSelection : filesystem.fileBytes,
    );
    writeFile(context.storage, "data", "shared bytes");
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    const outerHandle = admitted(context.host, prepared);
    try {
      await expect(context.host.exitStatus(outerHandle)).resolves.toMatchObject({ status: "ok" });
      expect(rejection).toBe("UNSUPPORTED");
      expect(parentStillUsable).toBe(true);
      expect(parentStateUnchanged).toBe(true);
      expect(context.host.processes.reap(outerHandle).status).toBe("ok");
    } finally {
      await context.close();
    }
  });

  it("rejects missing imports before module instantiation or the CLOEXEC sweep", async () => {
    let precommitStatePreserved = false;
    let admissionError = false;
    const outer: KernelProgramBinding = {
      manifest: manifest("outer"),
      implementation: {
        kind: "async",
        run: async (program) => {
          const fd = Number(program.args[0]);
          const descriptor = program.filesystem.descriptors.get(fd);
          const cloexecFd = program.filesystem.open(
            "/data",
            KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
          );
          const cloexecDescriptor = program.filesystem.descriptors.get(cloexecFd);
          descriptor.offset = 3n;
          cloexecDescriptor.offset = 6n;
          try {
            await program.exec({
              filesystem: program.filesystem,
              identity: program.identity,
              args: [],
              env: program.env,
              signal: program.signal,
              path: "/bin/rejected",
            });
          } catch (error) {
            admissionError =
              error instanceof KernelProgramExecAdmissionError && error.code === "ENOTSUP";
          }
          precommitStatePreserved =
            program.filesystem.descriptors.has(fd) &&
            descriptor.closeOnExec === false &&
            program.filesystem.descriptors.has(cloexecFd) &&
            cloexecDescriptor.closeOnExec === true &&
            descriptor.offset === 3n &&
            cloexecDescriptor.offset === 6n &&
            program.filesystem.fileBytes.kind === "view" &&
            program.filesystem.stat("/data").size === 12n;
          return { exitCode: 0, signal: 0, coreDumped: false };
        },
      },
    };
    const rejected: KernelProgramBinding = {
      manifest: manifest("rejected"),
      implementation: { kind: "wasm", module: wasmWithUnknownImport() },
    };
    const context = setup(
      new Map([
        ["/bin/outer", outer],
        ["/bin/rejected", rejected],
      ]),
      ({ executable, filesystem }) =>
        executable === "/bin/rejected" ? canonicalFileByteSelection : filesystem.fileBytes,
    );
    writeFile(context.storage, "data", "shared bytes");
    const fd = context.filesystem.open("/data", KernelOpenFlags.O_RDONLY);
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    const outerHandle = admitted(context.host, prepared, [String(fd)]);
    try {
      await expect(context.host.exitStatus(outerHandle)).resolves.toMatchObject({ status: "ok" });
      expect(admissionError).toBe(true);
      expect(precommitStatePreserved).toBe(true);
      expect(context.host.processes.reap(outerHandle).status).toBe("ok");
    } finally {
      await context.close();
    }
  });

  it("runs a replacement module start only after exec commits its descriptor sweep", async () => {
    let execError: unknown;
    let descriptorsAfterExec: readonly [boolean, boolean] | undefined;
    let bytesAfterExec: string | undefined;
    const outer: KernelProgramBinding = {
      manifest: manifest("outer"),
      implementation: {
        kind: "async",
        run: async (program) => {
          const firstFd = program.filesystem.open("/data", KernelOpenFlags.O_RDONLY);
          const secondFd = program.filesystem.open("/data", KernelOpenFlags.O_RDONLY);
          expect(firstFd).toBe(4);
          program.filesystem.descriptors.get(firstFd).closeOnExec = true;
          program.filesystem.descriptors.get(secondFd).closeOnExec = true;
          try {
            await program.exec({
              filesystem: program.filesystem,
              identity: program.identity,
              args: [],
              env: program.env,
              signal: program.signal,
              path: "/bin/replacement",
            });
          } catch (error) {
            execError = error;
          }
          descriptorsAfterExec = [
            program.filesystem.descriptors.has(firstFd),
            program.filesystem.descriptors.has(secondFd),
          ];
          bytesAfterExec = program.filesystem.fileBytes.kind;
          return { exitCode: 0, signal: 0, coreDumped: false };
        },
      },
    };
    const replacement: KernelProgramBinding = {
      manifest: manifest("replacement"),
      implementation: {
        kind: "wasm",
        module: wasmWithStartCheckingCloseOnExecWasSwept(4),
      },
    };
    const context = setup(
      new Map([
        ["/bin/outer", outer],
        ["/bin/replacement", replacement],
      ]),
      ({ executable, filesystem }) =>
        executable === "/bin/replacement" ? canonicalFileByteSelection : filesystem.fileBytes,
    );
    writeFile(context.storage, "data", "shared bytes");
    const outerHandle = admitted(
      context.host,
      context.host.prepare({ filesystem: context.filesystem }),
    );
    try {
      await expect(context.host.exitStatus(outerHandle)).resolves.toMatchObject({ status: "ok" });
      expect(execError).toBeUndefined();
      expect(descriptorsAfterExec).toEqual([false, false]);
      expect(bytesAfterExec).toBe("canonical");
      expect(context.host.processes.reap(outerHandle).status).toBe("ok");
    } finally {
      await context.close();
    }
  });

  it("rejects mismatched import kinds before mutating exec descriptors", async () => {
    let admissionError = false;
    let precommitStatePreserved = false;
    const outer: KernelProgramBinding = {
      manifest: manifest("outer"),
      implementation: {
        kind: "async",
        run: async (program) => {
          const firstFd = program.filesystem.open("/data", KernelOpenFlags.O_RDONLY);
          const secondFd = program.filesystem.open("/data", KernelOpenFlags.O_RDONLY);
          program.filesystem.descriptors.get(firstFd).closeOnExec = true;
          program.filesystem.descriptors.get(secondFd).closeOnExec = true;
          try {
            await program.exec({
              filesystem: program.filesystem,
              identity: program.identity,
              args: [],
              env: program.env,
              signal: program.signal,
              path: "/bin/bad-import-kind",
            });
          } catch (error) {
            admissionError =
              error instanceof KernelProgramExecAdmissionError && error.code === "EIO";
          }
          precommitStatePreserved =
            program.filesystem.descriptors.has(firstFd) &&
            program.filesystem.descriptors.has(secondFd) &&
            program.filesystem.descriptors.get(firstFd).closeOnExec &&
            program.filesystem.descriptors.get(secondFd).closeOnExec &&
            program.filesystem.fileBytes.kind === "view";
          return { exitCode: 0, signal: 0, coreDumped: false };
        },
      },
    };
    const badImport: KernelProgramBinding = {
      manifest: manifest("bad-import-kind"),
      implementation: {
        kind: "wasm",
        module: wasmWithFunctionAsMemoryImport(),
      },
    };
    const context = setup(
      new Map([
        ["/bin/outer", outer],
        ["/bin/bad-import-kind", badImport],
      ]),
      ({ executable, filesystem }) =>
        executable === "/bin/bad-import-kind" ? canonicalFileByteSelection : filesystem.fileBytes,
    );
    writeFile(context.storage, "data", "shared bytes");
    const outerHandle = admitted(
      context.host,
      context.host.prepare({ filesystem: context.filesystem }),
    );
    try {
      await expect(context.host.exitStatus(outerHandle)).resolves.toMatchObject({ status: "ok" });
      expect(admissionError).toBe(true);
      expect(precommitStatePreserved).toBe(true);
      expect(context.host.processes.reap(outerHandle).status).toBe("ok");
    } finally {
      await context.close();
    }
  });

  it("binds prepared open actions to their declared executable target", async () => {
    let executions = 0;
    const targetA: KernelProgramBinding = {
      manifest: manifest("target-a"),
      implementation: { kind: "javascript", runInline: () => 0 },
    };
    const targetB: KernelProgramBinding = {
      manifest: manifest("target-b"),
      implementation: {
        kind: "javascript",
        runInline: () => {
          executions++;
          return 0;
        },
      },
    };
    const context = setup(
      new Map([
        ["/bin/target-a", targetA],
        ["/bin/target-b", targetB],
      ]),
      ({ executable, filesystem }) =>
        executable === "/bin/target-a" ? canonicalFileByteSelection : filesystem.fileBytes,
    );
    writeFile(context.storage, "data", "original");
    let unscopedOpenCode: unknown;
    try {
      try {
        context.host.prepare(
          { filesystem: context.filesystem },
          {
            actions: [
              {
                kind: "open",
                fd: 4,
                sourceFd: 0,
                flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
                mode: 0,
                path: "/data",
              },
            ],
          },
        );
      } catch (error) {
        unscopedOpenCode = error instanceof Error && "code" in error ? error.code : undefined;
      }
      expect(unscopedOpenCode).toBe("ENOTSUP");
      expect(context.filesystem.stat("/data").size).toBe(8n);

      const prepared = context.host.prepare(
        { filesystem: context.filesystem },
        {
          executable: "/bin/target-a",
          actions: [
            {
              kind: "open",
              fd: 4,
              sourceFd: 0,
              flags: KernelOpenFlags.O_RDONLY,
              mode: 0,
              path: "/data",
            },
          ],
        },
      );
      const resolved = context.host.resolve("/bin/target-b");
      if (resolved.status !== "ok") throw new Error("Alternate target resolution failed");
      const result = callKernel(context.host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      expect(result).toMatchObject({ status: "error", error: { code: "INVALID_ARGUMENT" } });
      expect(executions).toBe(0);
      expect(context.host.processes.size).toBe(0);
      await prepared.release();
    } finally {
      await context.close();
    }
  });

  it("keeps an explicit selection through open actions when execution chooses another default", async () => {
    let selectorCalls = 0;
    let ranWithCanonical = false;
    let openedDescriptionWasCanonical = false;
    const tool: KernelProgramBinding = {
      manifest: manifest("tool"),
      implementation: {
        kind: "javascript",
        runInline: ({ filesystem }) => {
          ranWithCanonical = filesystem.fileBytes.kind === "canonical";
          openedDescriptionWasCanonical = filesystem.descriptors.get(4).byteView === undefined;
          return 0;
        },
      },
    };
    const context = setup(new Map([["/bin/tool", tool]]), ({ filesystem }) => {
      selectorCalls++;
      return filesystem.fileBytes;
    });
    writeFile(context.storage, "data", "original");
    try {
      const prepared = context.host.prepare(
        { filesystem: context.filesystem },
        {
          fileBytes: canonicalFileByteSelection,
          actions: [
            {
              kind: "open",
              fd: 4,
              sourceFd: 0,
              flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
              mode: 0,
              path: "/data",
            },
          ],
        },
      );
      const resolved = context.host.resolve("/bin/tool");
      if (resolved.status !== "ok") throw new Error("Tool resolution failed");
      expect(context.host.runInline(prepared, resolved.value, [], {})).toBe(0);
      expect(ranWithCanonical).toBe(true);
      expect(openedDescriptionWasCanonical).toBe(true);
      expect(selectorCalls).toBe(0);
      expect(context.filesystem.fileBytes.kind).toBe("view");
      expect(context.filesystem.stat("/data").size).toBe(0n);
    } finally {
      await context.close();
    }
  });

  it("does not change a prepared default when spawn admission rejects its parent", async () => {
    const tool: KernelProgramBinding = {
      manifest: manifest("tool"),
      implementation: { kind: "javascript", runInline: () => 0 },
    };
    const context = setup(new Map([["/bin/tool", tool]]), () => canonicalFileByteSelection);
    let parentHandle: KernelHandle<"process"> | undefined;
    let prepared: ReturnType<KernelProgramHost["prepare"]> | undefined;
    try {
      const parent = context.host.processes.spawn(
        undefined,
        () => ({
          completion: Promise.resolve({ exitCode: 0, signal: 0, coreDumped: false }),
          signal: () => ({ status: "ok", value: undefined }),
        }),
        () => undefined,
      );
      if (parent.status !== "ok") throw new Error("Could not create stale parent handle");
      parentHandle = parent.value.handle;
      await expect(context.host.exitStatus(parentHandle)).resolves.toMatchObject({ status: "ok" });
      expect(context.host.processes.reap(parentHandle).status).toBe("ok");

      prepared = context.host.prepare({ filesystem: context.filesystem, parent: parentHandle });
      const resolved = context.host.resolve("/bin/tool");
      if (resolved.status !== "ok") throw new Error("Tool resolution failed");
      const result = callKernel(context.host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      expect(result).toMatchObject({ status: "error", error: { code: "INVALID_HANDLE" } });
      expect(prepared.filesystem.fileBytes.kind).toBe("view");
      expect(context.filesystem.fileBytes.kind).toBe("view");
    } finally {
      if (prepared) await prepared.release();
      await context.close();
    }
  });
});
