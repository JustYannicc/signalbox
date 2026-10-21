// @effect-diagnostics-next-line nodeBuiltinImport:off - the fixture uses its own in-memory database, never live state.
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage, type FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { createKernelSessionStdio } from "../../kernel/KernelSessionStdio.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createNodeBridge } from "../../isolate/NodeBridge.ts";
import { createHarnessRuntime } from "./runtime.ts";

describe("Node harness terminal detection", () => {
  it.each([false, true])("installs guest tty with supplied native tty = %s", async (supplyTty) => {
    const database = new NodeSqlite.DatabaseSync(":memory:");
    const storage: FacetStorage = {
      sql: {
        databaseSize: 0,
        exec(query, ...bindings) {
          const statement = database.prepare(query);
          const values = bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          );
          if (statement.columns().length) return statement.all(...values);
          statement.run(...values);
          return [];
        },
      },
      transactionSync(callback) {
        database.exec("SAVEPOINT runtime_test");
        try {
          const result = callback();
          database.exec("RELEASE runtime_test");
          return result;
        } catch (error) {
          database.exec("ROLLBACK TO runtime_test; RELEASE runtime_test");
          throw error;
        }
      },
    };
    const wakes = new KernelWakeRegistry();
    const stdio = createKernelSessionStdio(wakes);
    const files = new KernelFileSystem({
      mounts: [{ path: "/", storage: createFacetSqliteStorage(storage, () => 0n) }],
      stdio: stdio.stdio,
    });
    const host = new KernelProgramHost({ registry: new KernelProgramRegistry(), wakes });
    const controller = new AbortController();
    let runtime: ReturnType<typeof createHarnessRuntime> | undefined;
    try {
      runtime = createHarnessRuntime(
        {
          host,
          computer: {
            threadId: "tty-test",
            files,
            exec: async () => {
              throw new Error("No child commands in this fixture");
            },
            port: async () => {
              throw new Error("No network ports in this fixture");
            },
            save: async () => {
              throw new Error("No commits in this fixture");
            },
          },
          stdio,
          identity: {
            version: "v24.18.0",
            versions: { node: "24.18.0" },
            platform: "linux",
            arch: "x64",
            homedir: "/",
            tmpdir: "/",
            pid: 1,
            ppid: 0,
            execPath: "/node",
            argv0: "node",
            argv: ["node", "/cli.js"],
            execArgv: [],
          },
          env: {},
          nativeModules: supplyTty
            ? {
                tty: {
                  isatty() {
                    throw new Error("Host descriptors must not be inspected");
                  },
                },
              }
            : {},
          loadPackages: async () => ({}),
          loadRelease: async () => {
            throw new Error("No release execution in this fixture");
          },
          bun: { main: "/cli.js", version: "1", revision: "test" },
          modelTransport: async () => {
            throw new Error("No model calls in this fixture");
          },
        },
        { lifetime: controller.signal, stdin: controller.signal, output: controller.signal },
        () => {
          throw new Error("No child processes in this fixture");
        },
        () => {
          throw new Error("No package initialization in this fixture");
        },
      );
      const bridge = createNodeBridge(runtime.modules);
      const tty = bridge.require("tty");
      expect(bridge.require("node:tty")).toBe(tty);
      const isatty = Reflect.get(tty, "isatty");
      for (const fd of [-1, 0, 1, 2, 42, NaN]) expect(isatty(fd)).toBe(false);
      for (const name of ["ReadStream", "WriteStream"]) {
        expect(() => Reflect.construct(Reflect.get(tty, name), [0])).toThrow(
          expect.objectContaining({ code: "ENOTSUP", syscall: `tty.${name}` }),
        );
      }
    } finally {
      controller.abort();
      for (const stream of Object.values(runtime?.streams ?? {})) {
        stream.on("error", () => {});
        stream.destroy();
      }
      await stdio.dispose();
      await host.processes.dispose();
      files.dispose();
      wakes.dispose();
      database.close();
    }
  });
});
