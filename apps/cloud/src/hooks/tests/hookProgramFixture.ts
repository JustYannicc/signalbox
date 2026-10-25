// @effect-diagnostics nodeBuiltinImport:off - test storage stays in an in-memory database.
import * as NodeSqlite from "node:sqlite";
import { expect } from "vite-plus/test";
import { KernelCommandExecutor } from "../../kernel/KernelCommandExecutor.ts";
import {
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
} from "../../kernel/KernelAbi.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { createFacetSqliteStorage, type FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import {
  KERNEL_HOOK_EXECUTABLE,
  registerKernelHookProgram,
  type KernelHookInvoker,
} from "../HookProgram.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();

function sqliteFixture() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  let depth = 0;
  const storage: FacetStorage = {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync(callback) {
      const name = `hook_test_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = callback();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
  return { storage, close: () => db.close() };
}

export const bytes = (value: string) => encoder.encode(value);

export function setup(invoke: KernelHookInvoker) {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, now) }],
  });
  filesystem.mkdir("/work");
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const programs = registerKernelHookProgram(registry, invoke);
  const host = new KernelProgramHost({ registry, wakes, programs });
  const executor = new KernelCommandExecutor({
    host,
    filesystem,
    forwarder: {
      spawn: async () => {
        throw new Error("Registered hook was forwarded");
      },
    },
  });
  return {
    filesystem,
    fixture,
    host,
    wakes,
    executor,
    async close(piped?: ReturnType<KernelProgramHost["preparePiped"]>) {
      await piped?.prepared.release();
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

export function prepare(test: ReturnType<typeof setup>, signal?: AbortSignal, cwd = "/work") {
  return test.host.preparePiped(
    { filesystem: test.filesystem, ...(signal === undefined ? {} : { signal }) },
    { cwd },
  );
}

export function spawn(
  test: ReturnType<typeof setup>,
  piped: ReturnType<typeof prepare>,
  args: readonly string[] = ["an-argv0-alias", "hook-id"],
  env: Readonly<Record<string, string>> = {},
): KernelHandle<"process"> {
  const resolved = test.host.resolve(KERNEL_HOOK_EXECUTABLE);
  if (resolved.status !== "ok") throw new Error("Hook program did not resolve");
  const result = callKernel(test.host.backend(piped.prepared), "process.spawn", {
    program: resolved.value,
    args,
    env,
  });
  if (result.status !== "ok") throw new Error("Hook program did not start");
  return result.value;
}

export async function writeInput(stream: WritableStream<Uint8Array>, input: Uint8Array) {
  const writer = stream.getWriter();
  await writer.write(input);
  await writer.close();
  writer.releaseLock();
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function collect(
  test: ReturnType<typeof setup>,
  piped: ReturnType<typeof prepare>,
  child: KernelHandle<"process">,
) {
  const stdout = readAll(piped.stdout);
  const stderr = readAll(piped.stderr);
  const exited = test.host.exitStatus(child);
  const result = { exited: await exited, stdout: await stdout, stderr: await stderr };
  expect(test.host.reap(child).status).toBe("ok");
  expect([...piped.prepared.filesystem.descriptors.entries()]).toHaveLength(0);
  expect(test.wakes.size).toBe(0);
  return result;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
