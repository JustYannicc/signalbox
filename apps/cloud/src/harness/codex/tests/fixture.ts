import { vi } from "vite-plus/test";
import type { Computer } from "../../../computer/Computer.ts";
import { KernelProgramRegistry, KernelWakeRegistry } from "../../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../kernel/KernelProgramHost.ts";
import { createKernelSessionStdio } from "../../../kernel/KernelSessionStdio.ts";
import { hostSqlite } from "../../tests/hostSqlite.ts";
import type { CodexHarnessProcessOptions } from "../../CodexHarnessProcess.ts";

export function fixture(engine: WebAssembly.Module, threadId = "test-thread") {
  const database = hostSqlite();
  const connection = database.open();
  const wakes = new KernelWakeRegistry();
  const stdio = createKernelSessionStdio(wakes);
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(connection.storage, () => 1n) }],
    stdio: stdio.stdio,
  });
  files.mkdir("/work");
  files.chdir("/work");
  stdio.assertBound(files);
  const host = new KernelProgramHost({ wakes, registry: new KernelProgramRegistry() });
  const exec = vi.fn<Computer["exec"]>(async () => {
    throw new Error("Unexpected exec");
  });
  const port = vi.fn<Computer["port"]>(async () => {
    throw new Error("Unexpected port");
  });
  const computer: Computer = {
    files,
    threadId,
    exec,
    port,
    save: async () => {
      throw new Error("Unexpected save");
    },
  };
  const options: CodexHarnessProcessOptions = {
    engine,
    host,
    stdio,
    computer,
    environment: { CODEX_EXEC_SERVER_URL: "ws://exec.test/session", HOME: "/home/test" },
    bootstrap: {
      type: "bootstrap",
      codex_home: "/home/test/.codex",
      cwd: "/work",
      overrides: { exact: true },
    },
    environmentInfo: {
      cwd: "/work",
      platformOs: "linux",
      shell: { name: "bash", path: "/bin/bash" },
      executorVersion: "test",
    },
    fetch: async () => {
      throw new Error("Unexpected HTTP request");
    },
    lifetime: { waitUntil: () => undefined },
    signal: new AbortController().signal,
  };
  return {
    options,
    files,
    stdio,
    host,
    wakes,
    exec,
    port,
    async close() {
      await host.processes.dispose();
      await stdio.dispose();
      files.dispose();
      database.dispose();
      wakes.dispose();
    },
  };
}

export function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
