import { describe, expect, it } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  callKernel,
  type KernelHandle,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import {
  createKernelRipgrepProgram,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,
} from "./KernelRipgrepProgram.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const cwd = "/work/deep";
const args = ["rg", "--count", "needle"];
const env = { PWD: "/stale", KEEP: "kept" };

describe("KernelProgram cwd environment", () => {
  it("opts into the prepared cwd without changing other env or args", async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    const wakes = new KernelWakeRegistry();
    filesystem.mkdir("/work");
    filesystem.mkdir(cwd);

    const registry = new KernelProgramRegistry();
    const outerManifest: RegisteredProgram = {
      name: "cwd-exec-wrapper",
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "cwd-exec-wrapper-1",
    };
    const plainManifest: RegisteredProgram = {
      ...KERNEL_RIPGREP_PROGRAM_MANIFEST,
      name: "ripgrep-without-cwd-environment",
      entrypoint: "ripgrep-without-cwd-environment-15.1.0",
    };
    for (const manifest of [KERNEL_RIPGREP_PROGRAM_MANIFEST, outerManifest, plainManifest]) {
      if (registry.register(manifest).status !== "ok") {
        throw new Error(`Could not register ${manifest.name}`);
      }
    }

    const wrapper: KernelProgramBinding = {
      manifest: outerManifest,
      implementation: {
        kind: "async",
        run: (program) => {
          const [path, ...childArgs] = program.args;
          if (!path) throw new Error("Exec wrapper requires a child program path");
          return program.exec({
            filesystem: program.filesystem,
            identity: program.identity,
            args: childArgs,
            env: program.env,
            signal: program.signal,
            path,
            ...(program.home === undefined ? {} : { home: program.home }),
          });
        },
      },
    };

    try {
      for (const inputEnv of [env, {}]) {
        const host = new KernelProgramHost({
          registry,
          wakes,
          programs: new Map([
            [
              "/bin/rg",
              {
                manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST,
                implementation: createKernelRipgrepProgram({
                  module: wasmExpectEnvironmentAndArgs({ ...inputEnv, PWD: cwd }, args),
                }),
              },
            ],
            [
              "/bin/plain-rg",
              {
                manifest: plainManifest,
                implementation: {
                  kind: "wasm",
                  module: wasmExpectEnvironmentAndArgs(inputEnv, args),
                },
              },
            ],
            ["/bin/outer", wrapper],
          ]),
        });

        try {
          for (const path of ["/bin/rg", "/bin/plain-rg"]) {
            const program = requireResolved(host, path);
            const inlinePrepared = host.prepare({ filesystem }, { cwd });
            expect(host.runInline(inlinePrepared, program, args, inputEnv)).toBe(0);

            const spawnPrepared = host.prepare({ filesystem }, { cwd });
            const spawned = callKernel(host.backend(spawnPrepared), "process.spawn", {
              program,
              args,
              env: inputEnv,
            });
            if (spawned.status !== "ok") throw new Error(`Could not start ${path}`);
            await expectExitCode(host, spawned.value, 0);

            const execPrepared = host.prepare({ filesystem }, { cwd });
            const outer = callKernel(host.backend(execPrepared), "process.spawn", {
              program: requireResolved(host, "/bin/outer"),
              args: [path, ...args],
              env: inputEnv,
            });
            if (outer.status !== "ok") throw new Error("Could not start exec wrapper");
            await expectExitCode(host, outer.value, 0);
          }
        } finally {
          await host.processes.dispose();
        }
      }

      expect(env).toEqual({ PWD: "/stale", KEEP: "kept" });
    } finally {
      wakes.dispose();
      filesystem.dispose();
      fixture.close();
    }
  });
});

async function expectExitCode(
  host: KernelProgramHost,
  handle: KernelHandle<"process">,
  exitCode: number,
) {
  await expect(host.exitStatus(handle)).resolves.toMatchObject({
    status: "ok",
    value: { exitCode },
  });
  expect(host.reap(handle).status).toBe("ok");
}

function requireResolved(host: KernelProgramHost, path: string) {
  const result = host.resolve(path);
  if (result.status !== "ok") throw new Error(`Could not resolve ${path}`);
  return result.value;
}

function wasmExpectEnvironmentAndArgs(
  environment: Readonly<Record<string, string>>,
  programArgs: readonly string[],
): WebAssembly.Module {
  const i32 = 0x7f;
  const signature = (params: readonly number[], results: readonly number[]) => [
    0x60,
    ...uleb(params.length),
    ...params,
    ...uleb(results.length),
    ...results,
  ];
  const wasiName = (name: string) => [...wasmName("wasi_snapshot_preview1"), ...wasmName(name)];
  const importFunction = (name: string, type: number) => [...wasiName(name), 0, ...uleb(type)];
  const imports = [
    ...uleb(5),
    ...importFunction("environ_sizes_get", 0),
    ...importFunction("args_sizes_get", 0),
    ...importFunction("environ_get", 0),
    ...importFunction("args_get", 0),
    ...importFunction("proc_exit", 1),
  ];
  const typeSection = section(1, [
    ...uleb(3),
    ...signature([i32, i32], [i32]),
    ...signature([i32], []),
    ...signature([], []),
  ]);
  const importSection = section(2, imports);
  const functionSection = section(3, [...uleb(1), ...uleb(2)]);
  const memorySection = section(5, [...uleb(1), 0, 1]);
  const exportSection = section(7, [
    ...uleb(2),
    ...wasmExport("memory", 2, 0),
    ...wasmExport("_start", 0, 5),
  ]);
  const environmentEntries = Object.entries(environment).map(([key, value]) =>
    new TextEncoder().encode(`${key}=${value}\0`),
  );
  const argumentEntries = programArgs.map((value) => new TextEncoder().encode(`${value}\0`));
  const checks = [
    ...compareI32(64, environmentEntries.length),
    ...compareI32(
      68,
      environmentEntries.reduce((size, value) => size + value.byteLength, 0),
    ),
    ...compareI32(72, argumentEntries.length),
    ...compareI32(
      76,
      argumentEntries.reduce((size, value) => size + value.byteLength, 0),
    ),
    ...environmentEntries.flatMap((bytes, index) => compareBytes(128, index, bytes)),
    ...argumentEntries.flatMap((bytes, index) => compareBytes(256, index, bytes)),
  ];
  const instructions = [
    ...callWasiPair(0, 64, 68),
    ...callWasiPair(1, 72, 76),
    ...callWasiPair(2, 128, 1024),
    ...callWasiPair(3, 256, 2048),
    ...i32Const(0),
    ...checks,
    0x10,
    4,
    0x0b,
  ];
  const functionBody = [0, ...instructions];
  const codeSection = section(10, [1, ...uleb(functionBody.length), ...functionBody]);
  return new WebAssembly.Module(
    new Uint8Array([
      ...new TextEncoder().encode("\0asm\x01\0\0\0"),
      ...typeSection,
      ...importSection,
      ...functionSection,
      ...memorySection,
      ...exportSection,
      ...codeSection,
    ]),
  );
}

function compareI32(address: number, expected: number): number[] {
  return [...load32(address), ...i32Const(expected), 0x47, 0x72];
}

function compareBytes(vector: number, index: number, expected: Uint8Array): number[] {
  return [...expected].flatMap((byte, offset) => [
    ...loadByteFromVector(vector, index, offset),
    ...i32Const(byte),
    0x47,
    0x72,
  ]);
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function wasmName(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...uleb(bytes.length), ...bytes];
}

function wasmExport(name: string, kind: number, index: number): number[] {
  return [...wasmName(name), kind, ...uleb(index)];
}

function callWasiPair(index: number, first: number, second: number): number[] {
  return [...i32Const(first), ...i32Const(second), 0x10, ...uleb(index), 0x1a];
}

function load32(address: number): number[] {
  return [...i32Const(address), 0x28, 2, 0];
}

function loadByteFromVector(vector: number, index: number, offset: number): number[] {
  return [...load32(vector + index * 4), ...i32Const(offset), 0x6a, 0x2d, 0, 0];
}

function i32Const(value: number): number[] {
  return [0x41, ...sleb(value)];
}

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function sleb(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0);
    bytes.push(byte | (done ? 0 : 0x80));
    if (done) return bytes;
  }
}
